import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { config } from '../config/index.mjs'
import {
  createApiClient,
  isBusinessRejection,
  matchesExpectedBusinessRejection
} from '../lib/api.mjs'
import { assertBusinessSuccess, isBusinessSuccess } from '../lib/assertions.mjs'
import { createProcurementPermissionReader } from './procurement-permission-reader.mjs'

export const IOT_E2E_PREFIX = 'E2E-IOT'

export const IOT_MESSAGE_RUNTIME_CASES = Object.freeze([
  'IOT-002',
  'IOT-009',
  'IOT-010',
  'IOT-011'
])

export const IOT_WRITE_ASSERTIONS = Object.freeze({
  'IOT-002': Object.freeze([
    '重复消息不重复落库',
    '异常值可观测',
    '告警状态可关闭',
    '租户和设备权限隔离'
  ]),
  'IOT-009': Object.freeze([
    '重复投递以 iot_device_message_idempotency 唯一键拦截，不二次写入属性历史',
    '乱序到达、质量码异常进入 iot_data_anomaly_queue 人工复核，不静默丢弃',
    '异常记录包含幂等键、来源序列号、质量码与原始参数',
    '待处理异常可处理为已处理或已忽略，状态不可重复处理'
  ]),
  'IOT-010': Object.freeze([
    '告警配置暴露持续时间、组合条件、抑制窗口与升级规则字段',
    '同一设备同一点位同一配置只保留一条活动告警，解除/关闭后释放活动键',
    '生命周期状态机 ACTIVE->ACKNOWLEDGED->WORK_ORDER->RESOLVED->CLOSED，非法流转被拒绝',
    '确认/转工单/解除/关闭均记录责任人、时间与处置说明'
  ]),
  'IOT-011': Object.freeze([
    '数据流转投递失败与未知设备上行消息登记到 iot_write_back_dead_letter，不静默丢弃',
    '死信按幂等键去重，记录来源时间/版本与最近失败原因',
    '死信状态区分待重试/重试中/已转死信/已人工接管',
    '人工接管记录接管人、时间与说明'
  ]),
  'IOT-013': Object.freeze([
    '设备台账返回资产状态 asset_status，与 IoT 连接状态 state 解耦',
    '非法资产状态提交被拒绝，合法状态可切换并在用例末尾恢复原值',
    '正式设备返回产品模型快照与接入配置版本（product_model_snapshot/access_config_version）',
    '产品接入配置（设备形态/联网方式/协议/序列化）变化时 iot_product.access_config_version 递增'
  ])
})

export const IOT_CONTRACT_GAPS = Object.freeze({
  'IOT-002': Object.freeze([
    '权限探针只验证本轮专属账号无 IoT 权限时的正式拒绝及租户头防伪造；第二真实租户主体访问设备数据的隔离仍未验证，整条租户和设备权限隔离不宣称完整通过。',
    'IOT-002 与 IOT-009 共用正式属性消息链，但告警闭环由 IOT-010 单独验证。'
  ]),
  'IOT-010': Object.freeze([
    '告警确认与转工单接口没有持久化处置说明，转工单也未校验真实工单归属；本轮不使用虚构工单 ID。',
    '当前服务允许 ACTIVE/ACKNOWLEDGED 直接解除或关闭，不能把非严格线性状态机登记为完整通过。'
  ]),
  'IOT-011': Object.freeze([
    '管理员正式发送接口要求真实设备，无法从该入口构造 UNKNOWN_DEVICE；本轮只验证真实 HTTP 目的投递失败。',
    '未发现正式重试执行器或同一死信幂等键重投入口，RETRYING/DEAD_LETTER 状态和去重重投保留 GAP。',
  ]),
  'IOT-013': Object.freeze([
    '设备详情需分别展示连接状态、资产状态和设备保存的接入版本/模型快照，不以当前产品配置冒充设备快照。',
    '新建隔离设备并通过正式 MES 状态开始/结束接口建立非空 RUNTIME 事实，资产状态切换后精确回读事件不变；结束运行状态并恢复资产状态后清理设备，结束事件保留审计。'
  ])
})

export const iotE2eMarker = (caseId, suffix = '') => {
  const random = randomBytes(4).toString('hex').toUpperCase()
  return [IOT_E2E_PREFIX, caseId, suffix, random].filter(Boolean).join('-')
}

export const isIotE2eMarker = (value) =>
  typeof value === 'string' && value.startsWith(`${IOT_E2E_PREFIX}-`)

export const assertIotLocalTarget = (runtime = config, { requireTenantId = true } = {}) => {
  if (runtime.target !== 'local' || runtime.tenantName !== 'CFOR 标准平台') {
    throw new Error('BLOCKED: IoT 专属写侧只允许本地 CFOR 标准平台租户')
  }
  for (const [value, port] of [[runtime.apiBase, '48083'], [runtime.webBase, '9151']]) {
    const url = new URL(value)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.protocol !== 'http:' || url.port !== port) {
      throw new Error('BLOCKED: IoT 写侧地址必须是本地 48083/9151')
    }
  }
  if (requireTenantId && String(runtime.tenantId || '') !== '1') {
    throw new Error('BLOCKED: IoT 写侧必须先确认 CFOR 标准平台真实 tenantId=1')
  }
  if (runtime.apiUrl && new URL(runtime.apiUrl).origin !== new URL(runtime.apiBase).origin) {
    throw new Error('BLOCKED: IoT API 前缀不得指向其他服务')
  }
}

export const assertIotMessageRuntimeEnabled = (runtime = config, caseId) => {
  if (!IOT_MESSAGE_RUNTIME_CASES.includes(caseId)) return
  if (runtime.iotRuntimeEnabled !== true) {
    throw new Error(
      `BLOCKED: IoT 运行时已关闭，${caseId} 依赖消息总线消费；` +
      '请在后端启用 cfor.iot.enabled 后设置 CFOR_IOT_RUNTIME_ENABLED=true 再复测'
    )
  }
}

export const initializeIotCatalogAssertions = (caseRecord, caseId) => {
  const assertions = IOT_WRITE_ASSERTIONS[caseId]
  if (!assertions) throw new Error(`Unsupported IoT write case: ${caseId}`)
  caseRecord.catalogAssertions = assertions.map((assertion, index) => ({
    index,
    assertion,
    status: 'GAP',
    evidenceChecks: [],
    details: IOT_CONTRACT_GAPS[caseId]?.join('；') || '尚未执行真实写侧验证'
  }))
}

export const markIotAssertion = (caseRecord, index, evidenceChecks, details = '') => {
  const row = caseRecord.catalogAssertions?.[index]
  if (!row) throw new Error(`IoT 目录断言索引不存在：${index}`)
  row.evidenceChecks = [...evidenceChecks]
  row.details = details
}

export const finalizeIotCatalogAssertions = (caseRecord) => {
  for (const row of caseRecord.catalogAssertions || []) {
    const checks = row.evidenceChecks.flatMap((name) =>
      caseRecord.checks.filter((check) => check.name === name))
    const missing = row.evidenceChecks.filter((name) =>
      !caseRecord.checks.some((check) => check.name === name))
    row.status = !row.details && row.evidenceChecks.length > 0 && !missing.length &&
      checks.every((check) => check.passed === true) ? 'VERIFIED' : 'GAP'
    if (row.status === 'GAP') {
      const reason = row.details ||
        `缺失或失败检查：${[...missing,
          ...checks.filter((check) => check.passed !== true).map((check) => check.name)]
          .join(', ') || '无结构化证据'}`
      const note = `${caseRecord.id || caseRecord.caseId || 'IoT'} ${row.assertion}：${reason}`
      if (!caseRecord.notes.includes(note)) caseRecord.notes.push(note)
    }
  }
  caseRecord.remainingAssertions = (caseRecord.catalogAssertions || [])
    .filter((row) => row.status !== 'VERIFIED')
    .map((row) => row.assertion)
  caseRecord.catalogComplete = Boolean(caseRecord.catalogAssertions?.length) &&
    caseRecord.remainingAssertions.length === 0
  return {
    partial: !caseRecord.catalogComplete,
    acceptanceComplete: caseRecord.catalogComplete &&
      caseRecord.checks.length > 0 &&
      caseRecord.checks.every((check) => check.passed === true),
    note: caseRecord.notes.join('；')
  }
}

export const strictId = (value, label) => {
  const text = typeof value === 'string'
    ? value.trim()
    : Number.isSafeInteger(value) ? String(value) : ''
  if (!/^[1-9]\d*$/.test(text) || BigInt(text) > 9223372036854775807n) {
    throw new Error(`${label}未返回精确的正整数 ID`)
  }
  return text
}

export const dataOf = (response) => {
  return response && typeof response === 'object' &&
    Object.prototype.hasOwnProperty.call(response, 'data') &&
    ('code' in response || 'msg' in response || 'success' in response)
    ? assertBusinessSuccess(response, 'IoT fixture API').data
    : response
}

export const rowsOf = (response) => {
  const payload = dataOf(response)
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.list)) return payload.list
  if (Array.isArray(payload?.records)) return payload.records
  throw new Error(`响应不是数组或分页列表：${JSON.stringify(payload)?.slice(0, 300)}`)
}

export const pageOf = (response) => {
  const payload = dataOf(response)
  const rows = Array.isArray(payload?.list)
    ? payload.list
    : Array.isArray(payload?.records)
      ? payload.records
      : null
  if (!payload || typeof payload !== 'object' || !rows ||
      !Number.isSafeInteger(payload.total) || payload.total < rows.length ||
      rows.length > 100 || !rows.every((row) =>
        row && typeof row === 'object' && !Array.isArray(row))) {
    throw new Error(`响应不是有效分页：${JSON.stringify(payload)?.slice(0, 300)}`)
  }
  return { ...payload, list: rows, total: payload.total }
}

export const requireIotE2eName = (value, label) => {
  if (!isIotE2eMarker(value)) {
    throw new Error(`${label}缺少 ${IOT_E2E_PREFIX}- 前缀：${value}`)
  }
  return value
}

export const requireIotMessageEvidence = (row, expected, label = 'IoT 设备消息') => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`${label}未返回可验证记录`)
  }
  const mismatches = ['deviceId', 'sequenceNo', 'qualityCode'].filter((field) =>
    row[field] == null || String(row[field]) !== String(expected[field]))
  if (row.identifier !== expected.identifier) mismatches.push('identifier')
  if (mismatches.length) {
    throw new Error(`${label}字段不一致：${mismatches.join(', ')}`)
  }
  return row
}

export const requireIotAnomalyEvidence = (row, expected, label = 'IoT 数据异常') => {
  requireIotMessageEvidence(row, expected, label)
  if (row.type !== expected.type) {
    throw new Error(`${label}异常类型 type 不一致`)
  }
  const expectedKey =
    `d:${expected.deviceId}:m:thing.property.post:i:${expected.identifier}:s:${expected.sequenceNo}`
  if (row.idempotentKey !== expectedKey) {
    throw new Error(`${label}幂等键 idempotentKey 不一致：${row.idempotentKey}`)
  }
  let payload
  try {
    if (typeof row.payload !== 'string') throw new Error('payload must be JSON text')
    payload = JSON.parse(row.payload)
  } catch {
    throw new Error(`${label}原始参数 payload 不是有效 JSON 文本`)
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(payload, expected.identifier) ||
      payload[expected.identifier] !== expected.value) {
    throw new Error(`${label}原始参数 payload 与单属性上报不一致`)
  }
  return row
}

export const IOT_PERMISSION_FORBIDDEN = Object.freeze({
  code: 403,
  message: '没有该操作权限'
})

export const IOT_TENANT_FORBIDDEN = Object.freeze({
  code: 403,
  message: '您无权访问该租户的数据'
})

export const isExactIotForbidden = (response, expected = IOT_PERMISSION_FORBIDDEN) => {
  const messages = [response?.msg, response?.message]
    .filter((value) => typeof value === 'string' && value.trim())
  return response?.code === expected.code &&
    !isBusinessSuccess(response) && response.success !== true && response.ok !== true &&
    response.data == null && messages.length > 0 &&
    messages.every((message) => message === expected.message)
}

export const verifyIotPermissionRejections = async ({
  adminApi,
  device,
  identifier,
  caseRecord,
  record,
  runtime = config
}, dependencies = {}) => {
  assertIotLocalTarget(runtime, { requireTenantId: false })
  if (runtime.tenantId && String(runtime.tenantId) !== '1') {
    throw new Error('BLOCKED: IoT 权限探针只允许本地 tenantId=1')
  }
  const deviceId = strictId(device?.id, 'IoT 权限探针设备')
  requireIotE2eName(device?.deviceName, 'IoT 权限探针设备')
  if (!/^[a-z][a-z0-9_]*$/.test(identifier || '')) {
    throw new Error('BLOCKED: IoT 权限探针缺少本轮真实属性标识')
  }
  const tenantId = strictId(dataOf(await adminApi.getBusiness(
    `/system/tenant/get-id-by-name?name=${encodeURIComponent(runtime.tenantName)}`
  )), 'IoT 权限探针租户')
  assertIotLocalTarget({ ...runtime, tenantId })
  const readDevice = async () => structuredClone(dataOf(await adminApi.getBusiness(
    `/iot/device/get?id=${encodeURIComponent(deviceId)}`
  )))
  const before = await readDevice()
  if (String(before?.id) !== deviceId || before.deviceName !== device.deviceName ||
      String(before.productId) !== strictId(device.productId, 'IoT 权限探针产品') ||
      !['ENABLED', 'DISABLED', 'SEALED', 'SCRAPPED'].includes(before.assetStatus)) {
    throw new Error('BLOCKED: IoT 权限探针设备归属或资产状态回读不匹配')
  }
  const permission = 'erp:settle-method-rule:query'
  const label = 'IOT002'
  const checkNames = []
  const check = (name, passed, details = '') => {
    checkNames.push(name)
    caseRecord.checks.push({ name, passed: Boolean(passed), details })
    if (!passed) throw new Error(`IoT 权限探针 ${name}`)
  }
  const secrets = []
  const safeMessage = (error) => secrets.reduce((text, secret) =>
    secret ? text.split(secret).join('[REDACTED]') : text, String(error?.message || error))
  const noteStart = caseRecord.notes.length
  let reader
  let createdAccount
  let token
  let readerApi
  let failure
  const cleanupErrors = []
  const results = []
  let unchanged = false
  let accountDeactivated = false
  let tenantHeaderRejected = false
  let tenantGap = '未回读到第二个启用租户，租户头防伪造探针未执行。'
  // Observe successful account creation so setup failures cannot strand an enabled user.
  const accountApi = new Proxy(adminApi, {
    get (target, property) {
      if (property === 'postBusiness') {
        return async (path, body) => {
          if (path === '/system/user/create') secrets.push(body.password)
          const response = await target.postBusiness(path, body)
          if (path === '/system/user/create') {
            createdAccount = {
              userId: strictId(dataOf(response), 'IoT 权限探针账号'),
              username: body.username,
              remark: body.remark
            }
          }
          return response
        }
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  try {
    reader = await (dependencies.createProcurementPermissionReader || createProcurementPermissionReader)(
      accountApi, caseRecord, { permission, label }
    )
    secrets.push(reader.credentials?.password)
    const userId = strictId(reader.userId, 'IoT 权限探针账号')
    const roleId = strictId(reader.roleId, 'IoT 权限探针角色')
    if (!/^autotestiot002[0-9a-f]{8}$/.test(reader.username || '') ||
        reader.credentials?.username !== reader.username ||
        (createdAccount && (createdAccount.userId !== userId ||
          createdAccount.username !== reader.username))) {
      throw new Error('BLOCKED: IoT 权限探针必须使用本轮新建的专属账号')
    }
    const user = dataOf(await adminApi.getBusiness(`/system/user/get?id=${userId}`))
    const role = dataOf(await adminApi.getBusiness(`/system/role/get?id=${roleId}`))
    const roles = rowsOf(await adminApi.getBusiness(
      `/system/permission/list-user-roles?userId=${userId}`
    ))
    if (String(user?.id) !== userId || user.username !== reader.username ||
        user.remark !== `${label} permission acceptance only` || user.status !== 0 ||
        String(role?.id) !== roleId || role.type !== 2 || role.status !== 0 ||
        !/^autotest_iot002_reader_[0-9a-f]{8}$/.test(role.code || '') ||
        roles.length !== 1 || strictId(roles[0], 'IoT 账号已分配角色') !== roleId) {
      throw new Error('BLOCKED: IoT 权限探针账号或唯一只读角色归属不匹配')
    }
    const client = dependencies.createApiClient || createApiClient
    // Keep login responses and credentials out of the shared report.
    const anonymous = client({ tenantId })
    const loginResponse = await anonymous.request('POST', '/system/auth/login-encrypted', {
      username: reader.username,
      password: reader.credentials.password,
      captchaVerification: '',
      rememberMe: false
    }, { encrypted: true })
    secrets.push(loginResponse?.data?.accessToken, loginResponse?.data?.refreshToken)
    const session = assertBusinessSuccess(loginResponse, 'IoT 专属账号加密登录').data
    token = session?.accessToken
    if (typeof token !== 'string' || !token || String(session.userId) !== userId ||
        String(session.tenantId) !== tenantId) {
      throw new Error('BLOCKED: IoT 权限探针登录主体或租户不匹配')
    }
    readerApi = client({ token, tenantId })
    const info = assertBusinessSuccess(await readerApi.getBusiness(
      '/system/auth/get-permission-info'
    ), 'IoT 专属账号权限回读').data
    check('IoT 权限探针真实账号/租户一致且无 IoT、通配或管理员授权',
      String(info?.user?.id) === userId && info.user.username === reader.username &&
      Array.isArray(info.roles) && info.roles.length === 1 && info.roles[0] === role.code &&
      Array.isArray(info.permissions) && info.permissions.includes(permission) &&
      info.permissions.every((value) => typeof value === 'string' &&
        !value.includes('*') && !value.startsWith('iot:') &&
        (!value || value.endsWith(':query'))),
      `userId=${userId}; roleId=${roleId}; tenantId=${tenantId}`)
    const requests = [
      ['设备详情', 'GET', `/iot/device/get?id=${deviceId}`],
      ['设备分页', 'GET', '/iot/device/page?pageNo=1&pageSize=100'],
      ['设备消息', 'GET', `/iot/device/message/page?pageNo=1&pageSize=100&deviceId=${deviceId}`],
      ['最新属性', 'GET', `/iot/device/property/get-latest?deviceId=${deviceId}`],
      ['属性历史', 'GET',
        `/iot/device/property/history-list?deviceId=${deviceId}&identifier=${encodeURIComponent(identifier)}`],
      // The service returns before mutation when the requested status equals the current one.
      ['同值资产状态写入', 'PUT', '/iot/device/asset-status',
        { id: deviceId, assetStatus: before.assetStatus, reason: `${IOT_E2E_PREFIX} permission no-op` }]
    ]
    for (const [name, method, path, body] of requests) {
      const response = await readerApi.request(method, path, body, {
        expectedBusinessRejection: { ...IOT_PERMISSION_FORBIDDEN, allowServiceCode: true }
      })
      record?.api?.push({ method, pathname: path, code: response?.code })
      check(`无 IoT 权限账号${name}被精确 403 拒绝`,
        isExactIotForbidden(response), `${method} ${path}; code=${response?.code}`)
      results.push({ method, pathname: path, code: response.code })
    }
    const tenants = rowsOf(await adminApi.getBusiness('/system/tenant/simple-list'))
    const otherTenant = tenants.find((row) => row?.id != null &&
      strictId(row.id, '租户头探针目标') !== tenantId)
    if (otherTenant) {
      const otherTenantId = strictId(otherTenant.id, '租户头探针目标')
      const path = `/iot/device/get?id=${deviceId}`
      const response = await readerApi.request('GET', path, undefined, {
        headers: { 'tenant-id': otherTenantId },
        expectedBusinessRejection: { ...IOT_TENANT_FORBIDDEN, allowServiceCode: true }
      })
      record?.api?.push({ method: 'GET', pathname: path, tenantId: otherTenantId, code: response?.code })
      check('IoT 专属账号伪造另一真实租户头被精确租户 403 拒绝',
        isExactIotForbidden(response, IOT_TENANT_FORBIDDEN),
        `sourceTenantId=${tenantId}; requestedTenantId=${otherTenantId}`)
      tenantHeaderRejected = true
      tenantGap = ''
    }
  } catch (error) {
    failure = error
  } finally {
    try {
      unchanged = isDeepStrictEqual(before, await readDevice())
      check('IoT 权限探针前后管理员回读专属设备完全一致', unchanged, `deviceId=${deviceId}`)
    } catch (error) {
      cleanupErrors.push(`管理员设备回读失败：${safeMessage(error)}`)
    }
    const account = createdAccount || reader
    if (account) {
      try {
        const userId = strictId(account.userId, 'IoT 待停用账号')
        const owned = dataOf(await adminApi.getBusiness(`/system/user/get?id=${userId}`))
        if (String(owned?.id) !== userId || owned.username !== account.username ||
            owned.remark !== `${label} permission acceptance only`) {
          throw new Error('IoT 待停用账号归属不匹配，拒绝改动其他账号')
        }
        assertBusinessSuccess(await adminApi.putBusiness('/system/user/update-status',
          { id: userId, status: 1 }), 'IoT 专属账号停用')
        const disabled = dataOf(await adminApi.getBusiness(`/system/user/get?id=${userId}`))
        accountDeactivated = String(disabled?.id) === userId &&
          disabled.username === account.username && disabled.status === 1
        check('IoT 权限探针账号 finally 停用并精确回读身份状态',
          accountDeactivated, `userId=${userId}; status=${disabled?.status}`)
        caseRecord.notes.push(`IoT 权限探针账号 ${account.username}(${userId}) 已停用，专属只读角色保留作审计。`)
      } catch (error) {
        caseRecord.checks.push({ name: 'IoT 权限探针账号停用失败', passed: false })
        cleanupErrors.push(`停用账号失败：${safeMessage(error)}`)
      }
    }
    if (token) {
      try {
        readerApi ||= (dependencies.createApiClient || createApiClient)({ token, tenantId })
        assertBusinessSuccess(await readerApi.request('POST', '/system/auth/logout'),
          'IoT 专属账号退出')
      } catch (error) {
        caseRecord.checks.push({ name: 'IoT 权限探针令牌退出失败', passed: false })
        cleanupErrors.push(`退出账号失败：${safeMessage(error)}`)
      }
    }
    for (let index = noteStart; index < caseRecord.notes.length; index++) {
      caseRecord.notes[index] = safeMessage(caseRecord.notes[index])
    }
  }
  if (failure || cleanupErrors.length) {
    throw new Error([failure && safeMessage(failure), ...cleanupErrors].filter(Boolean).join('；'))
  }
  const gap = [tenantGap,
    '仅证明本轮真实账号的功能权限拒绝及设备无副作用；未使用第二真实租户会话验证设备数据隔离，不把租户头拒绝当作整条隔离验收。'
  ].filter(Boolean).join('；')
  markIotAssertion(caseRecord, 3, checkNames, gap)
  caseRecord.evidence.push(
    `IOT-002 专属权限账号拒绝探针：${results.length} 条精确权限 403；设备前后不变=${unchanged}；账号停用=${accountDeactivated}；租户头拒绝=${tenantHeaderRejected}；第二租户数据隔离仍为 GAP。`
  )
  return { results, unchanged, accountDeactivated, tenantHeaderRejected, gap }
}

export const expectBusinessRejection = (response, message) => {
  return typeof message === 'object'
    ? matchesExpectedBusinessRejection(response, message)
    : isBusinessRejection(response) &&
      String(response?.msg || response?.message || '').includes(message)
}

export const trackResponse = (fixtures, response, label, cleanup) =>
  fixtures.track(response, label, cleanup)

export const createIotFixtureCleanup = ({ caseId, caseRecord }) => {
  const entries = []
  return {
    track (response, label, cleanup) {
      const id = strictId(dataOf(response), label)
      entries.push({ id, label, cleanup })
      return id
    },
    async cleanup (caseFailed) {
      const errors = []
      for (const entry of [...entries].reverse()) {
        try {
          const outcome = await entry.cleanup(entry.id)
          caseRecord.checks.push({
            name: outcome?.retained
              ? `${entry.label}隔离夹具已保留`
              : `${entry.label}测试数据已清理`,
            passed: true,
            details: `id=${entry.id}${outcome?.reason ? `, reason=${outcome.reason}` : ''}`
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          caseRecord.checks.push({
            name: `${entry.label}测试数据已清理`,
            passed: false,
            details: `id=${entry.id}: ${message}`
          })
          caseRecord.notes.push(`${caseId} 清理失败 ${entry.label} id=${entry.id}: ${message}`)
          errors.push(error)
        }
      }
      if (errors.length && !caseFailed) {
        throw new AggregateError(errors, `${caseId} 测试数据清理失败`)
      }
    }
  }
}

const findRow = (rows, predicate, label) => {
  const row = (rows || []).find(predicate)
  if (!row) throw new Error(`${label} 未在响应中找到`)
  return row
}

export const findIotE2eProduct = async (api, name) => {
  const page = pageOf(await api.getBusiness(
    `/iot/product/page?pageNo=1&pageSize=100&name=${encodeURIComponent(name)}`
  ))
  return page.list.find((row) => row.name === name) || null
}

export const createIotProductFixture = async (api, fixtures, options = {}) => {
  const marker = requireIotE2eName(options.marker || iotE2eMarker('PRODUCT'), 'IoT 产品')
  const categories = rowsOf(await api.getBusiness('/iot/product-category/simple-list'))
  const category = categories.find((row) => row?.id != null)
  if (!category) throw new Error('缺少 IoT 产品分类，无法创建专属产品')
  const body = {
    name: marker,
    categoryId: category.id,
    deviceType: options.deviceType ?? 0,
    netType: options.netType ?? 2,
    locationType: options.locationType ?? 3,
    protocolType: options.protocolType ?? 'mqtt',
    serializeType: options.serializeType ?? 'json',
    registerEnabled: options.registerEnabled ?? false,
    description: `${IOT_E2E_PREFIX} isolated product`
  }
  const productId = fixtures.track(
    await api.postBusiness('/iot/product/create', body),
    'IoT 产品',
    async (id) => {
      const existing = dataOf(await api.getBusiness(`/iot/product/get?id=${encodeURIComponent(id)}`))
      if (!existing) return
      if (existing.status === 1) {
        assertBusinessSuccess(
          await api.putBusiness(
            `/iot/product/update-status?id=${encodeURIComponent(id)}&status=0`
          ),
          `IoT 产品取消发布 id=${id}`
        )
      }
      assertBusinessSuccess(
        await api.deleteBusiness(`/iot/product/delete?id=${encodeURIComponent(id)}`),
        `IoT 产品清理 id=${id}`
      )
      const deleted = dataOf(await api.getBusiness(`/iot/product/get?id=${encodeURIComponent(id)}`))
      if (deleted) throw new Error(`IoT 产品删除后仍可读取 id=${id}`)
    }
  )
  const product = dataOf(await api.getBusiness(`/iot/product/get?id=${encodeURIComponent(productId)}`))
  if (String(product?.id) !== String(productId) || product.name !== marker) {
    throw new Error(`IoT 产品回读不一致 id=${productId}`)
  }
  return product
}

export const publishIotProductFixture = async (api, product) => {
  assertBusinessSuccess(
    await api.putBusiness(
      `/iot/product/update-status?id=${encodeURIComponent(product.id)}&status=1`
    ),
    `IoT 产品发布 id=${product.id}`
  )
  const published = dataOf(await api.getBusiness(
    `/iot/product/get?id=${encodeURIComponent(product.id)}`
  ))
  if (published?.status !== 1) {
    throw new Error(`IoT 产品发布回读状态不一致 id=${product.id}`)
  }
  return published
}

export const createIotNotifyTemplateFixture = async (api, fixtures, options = {}) => {
  const marker = requireIotE2eName(options.marker || iotE2eMarker('NOTIFY'), 'IoT 站内信模板')
  const code = `${marker.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
  const templateId = fixtures.track(
    await api.postBusiness('/system/notify-template/create', {
      name: marker,
      code,
      type: 1,
      nickname: marker,
      content: `${marker} {{configName}} {{deviceName}}`,
      status: 0,
      remark: `${IOT_E2E_PREFIX} isolated notify template`
    }),
    'IoT 站内信模板',
    async (id) => {
      const existing = dataOf(await api.getBusiness(
        `/system/notify-template/get?id=${encodeURIComponent(id)}`
      ))
      if (!existing) return
      if (existing.code !== code || existing.name !== marker) {
        throw new Error(`站内信模板所有权回读不一致 id=${id}`)
      }
      assertBusinessSuccess(
        await api.deleteBusiness(`/system/notify-template/delete?id=${encodeURIComponent(id)}`),
        `IoT 站内信模板清理 id=${id}`
      )
      const deleted = dataOf(await api.getBusiness(
        `/system/notify-template/get?id=${encodeURIComponent(id)}`
      ))
      if (deleted) throw new Error(`站内信模板删除后仍可读取 id=${id}`)
    }
  )
  const template = dataOf(await api.getBusiness(
    `/system/notify-template/get?id=${encodeURIComponent(templateId)}`
  ))
  if (String(template?.id) !== String(templateId) ||
      template.code !== code || template.name !== marker) {
    throw new Error(`IoT 站内信模板回读不一致 id=${templateId}`)
  }
  return template
}

export const updateIotProductFixture = async (api, product, changes) => {
  const body = {
    id: product.id,
    name: product.name,
    categoryId: product.categoryId,
    deviceType: product.deviceType,
    netType: product.netType,
    locationType: product.locationType,
    protocolType: product.protocolType,
    serializeType: product.serializeType,
    registerEnabled: product.registerEnabled,
    description: product.description,
    ...changes
  }
  assertBusinessSuccess(
    await api.putBusiness('/iot/product/update', body),
    `IoT 产品更新 id=${product.id}`
  )
  return dataOf(await api.getBusiness(`/iot/product/get?id=${encodeURIComponent(product.id)}`))
}

export const createIotDeviceGroupFixture = async (api, fixtures, options = {}) => {
  const marker = requireIotE2eName(options.marker || iotE2eMarker('GROUP'), 'IoT 设备分组')
  const groupId = fixtures.track(
    await api.postBusiness('/iot/device-group/create', {
      name: marker,
      status: options.status ?? 0,
      description: `${IOT_E2E_PREFIX} isolated group`
    }),
    'IoT 设备分组',
    async (id) => {
      const existing = dataOf(await api.getBusiness(`/iot/device-group/get?id=${encodeURIComponent(id)}`))
      if (!existing) return
      assertBusinessSuccess(
        await api.deleteBusiness(`/iot/device-group/delete?id=${encodeURIComponent(id)}`),
        `IoT 设备分组清理 id=${id}`
      )
      const deleted = dataOf(await api.getBusiness(`/iot/device-group/get?id=${encodeURIComponent(id)}`))
      if (deleted) throw new Error(`IoT 设备分组删除后仍可读取 id=${id}`)
    }
  )
  const group = dataOf(await api.getBusiness(`/iot/device-group/get?id=${encodeURIComponent(groupId)}`))
  if (String(group?.id) !== String(groupId) || group.name !== marker) {
    throw new Error(`IoT 设备分组回读不一致 id=${groupId}`)
  }
  return group
}

export const createIotPropertyFixture = async (api, fixtures, product, options = {}) => {
  const identifier = options.identifier || iotE2eMarker('PROPERTY').toLowerCase().replace(/-/g, '_')
  const name = requireIotE2eName(
    options.name || iotE2eMarker('PROPERTY-NAME'),
    'IoT 物模型'
  )
  const property = {
    identifier,
    name,
    accessMode: options.accessMode ?? 'rw',
    required: false,
    dataType: options.dataType ?? 'double',
    dataSpecs: options.dataSpecs ?? {
      dataType: 'double',
      min: '-100',
      max: '1000',
      unit: 'C',
      unitName: '摄氏度'
    }
  }
  const modelId = fixtures.track(
    await api.postBusiness('/iot/thing-model/create', {
      productId: product.id,
      productKey: product.productKey,
      identifier,
      name,
      description: `${IOT_E2E_PREFIX} isolated property`,
      type: 1,
      property
    }),
    'IoT 物模型属性',
    async (id) => {
      const existing = dataOf(await api.getBusiness(`/iot/thing-model/get?id=${encodeURIComponent(id)}`))
      if (!existing) return
      const product = dataOf(await api.getBusiness(
        `/iot/product/get?id=${encodeURIComponent(existing.productId)}`
      ))
      if (!product || !isIotE2eMarker(product.name)) {
        throw new Error(`IoT 物模型所属产品所有权回读失败 id=${id}`)
      }
      if (product.status === 1) {
        assertBusinessSuccess(
          await api.putBusiness(
            `/iot/product/update-status?id=${encodeURIComponent(product.id)}&status=0`
          ),
          `IoT 物模型清理前取消产品发布 id=${product.id}`
        )
      }
      assertBusinessSuccess(
        await api.deleteBusiness(`/iot/thing-model/delete?id=${encodeURIComponent(id)}`),
        `IoT 物模型清理 id=${id}`
      )
      const deleted = dataOf(await api.getBusiness(`/iot/thing-model/get?id=${encodeURIComponent(id)}`))
      if (deleted) throw new Error(`IoT 物模型删除后仍可读取 id=${id}`)
    }
  )
  const model = dataOf(await api.getBusiness(`/iot/thing-model/get?id=${encodeURIComponent(modelId)}`))
  if (String(model?.id) !== String(modelId) || model.identifier !== identifier ||
      String(model.productId) !== String(product.id)) {
    throw new Error(`IoT 物模型回读不一致 id=${modelId}`)
  }
  return model
}

export const createIotDeviceFixture = async (api, fixtures, product, options = {}) => {
  const marker = requireIotE2eName(options.marker || iotE2eMarker('DEVICE'), 'IoT 设备')
  const body = {
    productId: product.id,
    deviceName: marker,
    nickname: options.nickname,
    serialNumber: options.serialNumber,
    groupIds: options.groupIds,
    deptId: options.deptId,
    locationType: options.locationType ?? 3,
    productionLineId: options.productionLineId ?? ''
  }
  const deviceId = fixtures.track(
    await api.postBusiness('/iot/device/create', body),
    'IoT 设备',
    async (id) => {
      const existing = dataOf(await api.getBusiness(`/iot/device/get?id=${encodeURIComponent(id)}`))
      if (!existing) return
      if (!isIotE2eMarker(existing.deviceName)) {
        throw new Error(`IoT 设备清理所有权不一致 id=${id}`)
      }
      if (existing.assetStatus === 'DISABLED') {
        assertBusinessSuccess(
          await api.putBusiness('/iot/device/asset-status', {
            id,
            assetStatus: 'ENABLED',
            reason: `${IOT_E2E_PREFIX} cleanup restore`
          }),
          `IoT 设备资产状态恢复 id=${id}`
        )
        const restored = dataOf(await api.getBusiness(
          `/iot/device/get?id=${encodeURIComponent(id)}`
        ))
        if (restored?.assetStatus !== 'ENABLED') {
          throw new Error(`IoT 设备资产状态恢复回读失败 id=${id}`)
        }
      }
      assertBusinessSuccess(
        await api.deleteBusiness(`/iot/device/delete?id=${encodeURIComponent(id)}`),
        `IoT 设备清理 id=${id}`
      )
      const deleted = dataOf(await api.getBusiness(`/iot/device/get?id=${encodeURIComponent(id)}`))
      if (deleted) throw new Error(`IoT 设备删除后仍可读取 id=${id}`)
    }
  )
  const device = dataOf(await api.getBusiness(`/iot/device/get?id=${encodeURIComponent(deviceId)}`))
  if (String(device?.id) !== String(deviceId) ||
      String(device.productId) !== String(product.id) ||
      device.deviceName !== marker) {
    throw new Error(`IoT 设备回读不一致 id=${deviceId}`)
  }
  return device
}

export const parseDeviceSnapshot = (device, caseRecord) => {
  let snapshot
  try {
    snapshot = JSON.parse(device?.productModelSnapshot)
  } catch {
    snapshot = null
  }
  caseRecord.checks.push({
    name: '设备产品模型快照为完整对象并精确绑定产品与接入版本',
    passed:
      snapshot != null &&
      typeof snapshot === 'object' &&
      !Array.isArray(snapshot) &&
      String(snapshot.productId) === String(device.productId) &&
      Number.isSafeInteger(snapshot.accessConfigVersion) &&
      snapshot.accessConfigVersion === device.accessConfigVersion &&
      ['productKey', 'protocolType', 'serializeType'].every((key) =>
        typeof snapshot[key] === 'string' && snapshot[key].trim() !== '') &&
      ['deviceType', 'netType'].every((key) => Number.isSafeInteger(snapshot[key])),
    details: `deviceId=${device?.id}, version=${device?.accessConfigVersion}`
  })
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error(`设备产品模型快照非法 deviceId=${device?.id}`)
  }
  return snapshot
}

export const waitForCondition = async (
  load,
  predicate,
  {
    timeoutMs = 15000,
    intervalMs = 300,
    label = '条件'
  } = {}
) => {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() <= deadline) {
    last = await load()
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`${label}等待超时：${JSON.stringify(last)?.slice(0, 500)}`)
}

const sendProperty = async (api, device, identifier, payload) => {
  return api.postBusiness('/iot/device/message/send', {
    method: 'thing.property.post',
    params: { [identifier]: payload.value },
    deviceId: device.id,
    reportTime: payload.reportTime,
    pointVersion: payload.pointVersion ?? 1,
    sequenceNo: payload.sequenceNo,
    qualityCode: payload.qualityCode ?? 0,
    preserveReportTime: true
  })
}

const messageRows = async (api, deviceId) =>
  pageOf(await api.getBusiness(
    `/iot/device/message/page?pageNo=1&pageSize=100&deviceId=${encodeURIComponent(deviceId)}`
  )).list

const anomalyRows = async (api, deviceId, type) =>
  pageOf(await api.getBusiness(
    `/iot/data-anomaly/page?pageNo=1&pageSize=100&deviceId=${encodeURIComponent(deviceId)}` +
    `&type=${encodeURIComponent(type)}`
  )).list.filter((row) => row.type === type)

const findAnomaly = (rows, sequenceNo) => rows.find((row) =>
  String(row.sequenceNo) === String(sequenceNo))

export const runIotAnomalyClosure = async ({
  api,
  fixtures,
  caseRecord,
  waitOptions = {}
}) => {
  const product = await createIotProductFixture(api, fixtures, {
    marker: iotE2eMarker('009-PRODUCT')
  })
  const identifier = 'e2e_009_signal'
  await createIotPropertyFixture(api, fixtures, product, {
    identifier,
    name: iotE2eMarker('009-PROPERTY')
  })
  await publishIotProductFixture(api, product)
  const device = await createIotDeviceFixture(api, fixtures, product, {
    marker: iotE2eMarker('009-DEVICE')
  })

  const baseTime = Date.now() - 60_000
  await sendProperty(api, device, identifier, {
    value: 10,
    reportTime: new Date(baseTime).toISOString().slice(0, 19),
    sequenceNo: 9001
  })
  const firstMessageRows = await waitForCondition(
    () => messageRows(api, device.id),
    (rows) => rows.some((row) => String(row.sequenceNo) === '9001'),
    { ...waitOptions, label: '首条消息消费完成' }
  )
  const firstMessage = requireIotMessageEvidence(
    firstMessageRows.find((row) => String(row.sequenceNo) === '9001'),
    { deviceId: device.id, identifier, sequenceNo: 9001, qualityCode: 0 },
    '首条 PROPERTY_POST 消息'
  )
  caseRecord.checks.push({
    name: '首条属性消息回读设备/标识/来源序列号/质量码一致',
    passed: true,
    details: JSON.stringify(firstMessage)
  })

  await sendProperty(api, device, identifier, {
    value: 10,
    reportTime: new Date(baseTime).toISOString().slice(0, 19),
    sequenceNo: 9001
  })
  const duplicate = await waitForCondition(
    () => anomalyRows(api, device.id, 'DUPLICATE'),
    (rows) => Boolean(findAnomaly(rows, 9001)),
    { ...waitOptions, label: 'DUPLICATE 重复消息异常登记' }
  )
  const duplicateRow = requireIotAnomalyEvidence(findAnomaly(duplicate, 9001), {
    type: 'DUPLICATE',
    deviceId: device.id,
    identifier,
    sequenceNo: 9001,
    qualityCode: 0,
    value: 10
  }, 'DUPLICATE 异常')
  caseRecord.checks.push({
    name: '重复投递按来源序列号进入 DUPLICATE 异常且只保留一条',
    passed: duplicate.filter((row) => String(row.sequenceNo) === '9001').length === 1,
    details: JSON.stringify(duplicateRow)
  })

  const historyQuery = new URLSearchParams({
    deviceId: String(device.id),
    identifier
  })
  const history = rowsOf(await api.getBusiness(
    `/iot/device/property/history-list?${historyQuery}`
  ))
  caseRecord.checks.push({
    name: '重复消息不二次写入属性历史',
    passed: history.filter((row) => Number(row.value) === 10).length === 1,
    details: `history=${history.length}, value10=${history.filter((row) => Number(row.value) === 10).length}`
  })

  const highTime = baseTime + 30_000
  const lowTime = baseTime + 20_000
  await sendProperty(api, device, identifier, {
    value: 20,
    reportTime: new Date(highTime).toISOString().slice(0, 19),
    sequenceNo: 9002
  })
  await waitForCondition(
    () => messageRows(api, device.id),
    (rows) => rows.some((row) => String(row.sequenceNo) === '9002'),
    { ...waitOptions, label: '高时间消息消费完成' }
  )
  await sendProperty(api, device, identifier, {
    value: 21,
    reportTime: new Date(lowTime).toISOString().slice(0, 19),
    sequenceNo: 9003
  })
  const outOfOrder = await waitForCondition(
    () => anomalyRows(api, device.id, 'OUT_OF_ORDER'),
    (rows) => Boolean(findAnomaly(rows, 9003)),
    { timeoutMs: 5000, ...waitOptions, label: 'OUT_OF_ORDER 乱序异常登记' }
  )
  const outOfOrderRow = requireIotAnomalyEvidence(findAnomaly(outOfOrder, 9003), {
    type: 'OUT_OF_ORDER',
    deviceId: device.id,
    identifier,
    sequenceNo: 9003,
    qualityCode: 0,
    value: 21
  }, 'OUT_OF_ORDER 异常')
  caseRecord.checks.push({
    name: '后到低时间消息进入 OUT_OF_ORDER 异常',
    passed: true,
    details: JSON.stringify(outOfOrderRow)
  })

  await sendProperty(api, device, identifier, {
    value: 30,
    reportTime: new Date(baseTime + 40_000).toISOString().slice(0, 19),
    sequenceNo: 9004,
    qualityCode: 7
  })
  const quality = await waitForCondition(
    () => anomalyRows(api, device.id, 'QUALITY_CODE'),
    (rows) => Boolean(findAnomaly(rows, 9004)),
    { ...waitOptions, label: 'QUALITY_CODE 质量码异常登记' }
  )
  const qualityRow = requireIotAnomalyEvidence(findAnomaly(quality, 9004), {
    type: 'QUALITY_CODE',
    deviceId: device.id,
    identifier,
    sequenceNo: 9004,
    qualityCode: 7,
    value: 30
  }, 'QUALITY_CODE 异常')
  caseRecord.checks.push({
    name: '非零质量码进入 QUALITY_CODE 异常并保留原始参数',
    passed: true,
    details: JSON.stringify(qualityRow)
  })

  const anomalies = [duplicateRow, outOfOrderRow, qualityRow]
  const handledRows = []
  for (const anomaly of anomalies) {
    assertBusinessSuccess(
      await api.putBusiness('/iot/data-anomaly/handle', {
        id: anomaly.id,
        status: 1,
        handleRemark: `${IOT_E2E_PREFIX} 已处理`
      }),
      `处理异常 id=${anomaly.id}`
    )
    const handled = dataOf(await api.getBusiness(
      `/iot/data-anomaly/get?id=${encodeURIComponent(anomaly.id)}`
    ))
    const repeated = await api.request('PUT', '/iot/data-anomaly/handle', {
      id: anomaly.id,
      status: 1,
      handleRemark: `${IOT_E2E_PREFIX} repeated`
    }, {
      expectedBusinessRejection: {
        code: 1050017001,
        message: 'IoT 数据异常记录已处理'
      }
    })
    handledRows.push({ handled, repeated })
  }
  const repeatRejected = handledRows.length === anomalies.length &&
    handledRows.every(({ repeated }) => matchesExpectedBusinessRejection(repeated, {
      code: 1050017001,
      message: 'IoT 数据异常记录已处理'
    }))
  caseRecord.checks.push({
    name: '异常处理记录处理人/时间/说明且禁止重复处理',
    passed:
      handledRows.length === anomalies.length &&
      anomalies.length === 3 &&
      handledRows.every(({ handled }) =>
        handled.status === 1 &&
        handled.handleUserId != null &&
        Boolean(handled.handleTime) &&
        handled.handleRemark === `${IOT_E2E_PREFIX} 已处理`) &&
      repeatRejected,
    details: `handled=${handledRows.length}, repeatRejected=${repeatRejected}`
  })
  caseRecord.notes.push(
    'IoT 数据异常队列没有删除接口；E2E 仅处理专属异常并保留处理审计事实。'
  )
  if (caseRecord.caseId === 'IOT-002' || caseRecord.id === 'IOT-002') {
    markIotAssertion(caseRecord, 0, [
      '重复投递按来源序列号进入 DUPLICATE 异常且只保留一条',
      '重复消息不二次写入属性历史'
    ])
    markIotAssertion(caseRecord, 1, [
      '后到低时间消息进入 OUT_OF_ORDER 异常',
      '非零质量码进入 QUALITY_CODE 异常并保留原始参数'
    ])
    markIotAssertion(caseRecord, 2, [], '告警关闭链路由 IOT-010 专属告警夹具验证，本用例未跨案例伪造告警事实。')
    markIotAssertion(caseRecord, 3, [], '本用例真实账号拒绝探针尚未执行，租户和设备权限隔离保留 GAP。')
  } else {
    markIotAssertion(caseRecord, 0, [
      '重复投递按来源序列号进入 DUPLICATE 异常且只保留一条',
      '重复消息不二次写入属性历史'
    ])
    markIotAssertion(caseRecord, 1, [
      '后到低时间消息进入 OUT_OF_ORDER 异常',
      '非零质量码进入 QUALITY_CODE 异常并保留原始参数'
    ])
    markIotAssertion(caseRecord, 2, [
      '首条属性消息回读设备/标识/来源序列号/质量码一致',
      '重复投递按来源序列号进入 DUPLICATE 异常且只保留一条',
      '后到低时间消息进入 OUT_OF_ORDER 异常',
      '非零质量码进入 QUALITY_CODE 异常并保留原始参数'
    ])
    markIotAssertion(caseRecord, 3, [
      '异常处理记录处理人/时间/说明且禁止重复处理'
    ])
  }
  return { product, device, identifier }
}

const alertRows = async (api, deviceId, configId) =>
  pageOf(await api.getBusiness(
    `/iot/alert-record/page?pageNo=1&pageSize=100&deviceId=${encodeURIComponent(deviceId)}` +
    `&configId=${encodeURIComponent(configId)}`
  )).list

export const runIotAlertLifecycleClosure = async ({
  api,
  fixtures,
  caseRecord
}) => {
  const profile = dataOf(await api.getBusiness('/system/user/profile/get'))
  const userId = strictId(profile?.id, 'IoT 告警接收用户')
  const template = await createIotNotifyTemplateFixture(api, fixtures, {
    marker: iotE2eMarker('010-NOTIFY')
  })
  const product = await createIotProductFixture(api, fixtures, {
    marker: iotE2eMarker('010-PRODUCT')
  })
  const identifier = 'e2e_010_temperature'
  await createIotPropertyFixture(api, fixtures, product, {
    identifier,
    name: iotE2eMarker('010-PROPERTY')
  })
  const device = await createIotDeviceFixture(api, fixtures, product, {
    marker: iotE2eMarker('010-DEVICE')
  })
  const sceneRuleId = fixtures.track(
    await api.postBusiness('/iot/scene-rule/create', {
      name: iotE2eMarker('010-SCENE'),
      description: `${IOT_E2E_PREFIX} isolated alert scene`,
      status: 0,
      triggers: [{
        type: 2,
        productId: product.id,
        deviceId: device.id,
        identifier,
        operator: '=',
        value: '80'
      }],
      actions: [{ type: 100, productId: product.id, deviceId: device.id }]
    }),
    'IoT 场景规则',
    async (id) => {
      const existing = dataOf(await api.getBusiness(`/iot/scene-rule/get?id=${encodeURIComponent(id)}`))
      if (!existing) return
      assertBusinessSuccess(
        await api.deleteBusiness(`/iot/scene-rule/delete?id=${encodeURIComponent(id)}`),
        `IoT 场景规则清理 id=${id}`
      )
    }
  )
  const configId = fixtures.track(
    await api.postBusiness('/iot/alert-config/create', {
      name: iotE2eMarker('010-CONFIG'),
      description: `${IOT_E2E_PREFIX} isolated alert config`,
      level: 2,
      status: 0,
      sceneRuleIds: [sceneRuleId],
      receiveUserIds: [userId],
      receiveTypes: [3],
      notifyTemplateCode: template.code,
      durationSeconds: 0,
      combineMode: 'OR',
      combineExpression: '',
      suppressSeconds: 0,
      escalateSeconds: 0,
      escalateLevel: 3
    }),
    'IoT 告警配置',
    async (id) => {
      const existing = dataOf(await api.getBusiness(`/iot/alert-config/get?id=${encodeURIComponent(id)}`))
      if (!existing) return
      assertBusinessSuccess(
        await api.deleteBusiness(`/iot/alert-config/delete?id=${encodeURIComponent(id)}`),
        `IoT 告警配置清理 id=${id}`
      )
    }
  )
  const alertConfig = dataOf(await api.getBusiness(
    `/iot/alert-config/get?id=${encodeURIComponent(configId)}`
  ))
  caseRecord.checks.push({
    name: '告警配置正式回读持续/组合/抑制/升级字段',
    passed:
      String(alertConfig?.id) === String(configId) &&
      Number(alertConfig.durationSeconds) === 0 &&
      alertConfig.combineMode === 'OR' &&
      Number(alertConfig.suppressSeconds) === 0 &&
      Number(alertConfig.escalateSeconds) === 0 &&
      Number(alertConfig.escalateLevel) === 3 &&
      alertConfig.notifyTemplateCode === template.code &&
      alertConfig.receiveUserIds?.map(String).includes(userId),
    details: `config=${configId}, template=${template.code}, user=${userId}`
  })
  await publishIotProductFixture(api, product)

  const now = Date.now() - 10_000
  await sendProperty(api, device, identifier, {
    value: 80,
    reportTime: new Date(now).toISOString().slice(0, 19),
    sequenceNo: 10001
  })
  const activeRows = await waitForCondition(
    () => alertRows(api, device.id, configId),
    (rows) => rows.length === 1,
    { label: '告警触发' }
  )
  const active = activeRows[0]
  await sendProperty(api, device, identifier, {
    value: 80,
    reportTime: new Date(now + 1000).toISOString().slice(0, 19),
    sequenceNo: 10002
  })
  await waitForCondition(
    () => messageRows(api, device.id),
    (rows) => rows.some((row) => String(row.sequenceNo) === '10002'),
    { label: '重复告警消息消费完成' }
  )
  const activeAfterRepeat = await waitForCondition(
    () => alertRows(api, device.id, configId),
    (rows) => rows.length >= 1,
    { label: '重复告警唯一活动键回读' }
  )
  caseRecord.checks.push({
    name: '同一设备点位配置仅保留一条活动告警',
    passed:
      active.alertStatus === 'ACTIVE' &&
      activeAfterRepeat.length === 1 &&
      String(activeAfterRepeat[0].id) === String(active.id),
    details: `alertId=${active.id}, rows=${activeAfterRepeat.length}`
  })

  assertBusinessSuccess(
    await api.putBusiness('/iot/alert-record/acknowledge', {
      id: active.id,
      remark: `${IOT_E2E_PREFIX} 已确认`
    }),
    '告警确认'
  )
  assertBusinessSuccess(
    await api.putBusiness('/iot/alert-record/resolve', {
      id: active.id,
      remark: `${IOT_E2E_PREFIX} 已解除`
    }),
    '告警解除'
  )
  assertBusinessSuccess(
    await api.putBusiness('/iot/alert-record/close', {
      id: active.id,
      remark: `${IOT_E2E_PREFIX} 已关闭`
    }),
    '告警关闭'
  )
  const closed = dataOf(await api.getBusiness(
    `/iot/alert-record/get?id=${encodeURIComponent(active.id)}`
  ))
  const illegalTransition = await api.request('PUT', '/iot/alert-record/resolve', {
    id: active.id,
    remark: `${IOT_E2E_PREFIX} illegal`
  }, {
    expectedBusinessRejection: {
      code: 1050014001,
      message: 'IoT 告警记录状态不允许该操作'
    }
  })
  const illegalTransitionRejected = matchesExpectedBusinessRejection(illegalTransition, {
    code: 1050014001,
    message: 'IoT 告警记录状态不允许该操作'
  })
  caseRecord.checks.push({
    name: '告警确认/解除/关闭记录责任人、时间和正式处置说明',
    passed:
      closed.alertStatus === 'CLOSED' &&
      closed.acknowledgeUserId != null &&
      Boolean(closed.acknowledgeTime) &&
      closed.resolveUserId != null &&
      Boolean(closed.resolveTime) &&
      closed.resolveRemark === `${IOT_E2E_PREFIX} 已解除` &&
      closed.closeUserId != null &&
      Boolean(closed.closeTime) &&
      closed.closeRemark === `${IOT_E2E_PREFIX} 已关闭` &&
      illegalTransitionRejected,
    details: `alertId=${active.id}, status=${closed.alertStatus}, illegalRejected=${illegalTransitionRejected}`
  })
  await sendProperty(api, device, identifier, {
    value: 80,
    reportTime: new Date(now + 3000).toISOString().slice(0, 19),
    sequenceNo: 10003
  })
  await waitForCondition(
    () => messageRows(api, device.id),
    (rows) => rows.some((row) => String(row.sequenceNo) === '10003'),
    { label: '关闭后新告警周期消息消费完成' }
  )
  const nextCycle = await waitForCondition(
    () => alertRows(api, device.id, configId),
    (rows) => rows.some((row) =>
      String(row.id) !== String(active.id) && row.alertStatus === 'ACTIVE'),
    { label: '解除关闭后活动键释放' }
  )
  const nextActive = nextCycle.find((row) =>
    String(row.id) !== String(active.id) && row.alertStatus === 'ACTIVE')
  if (nextActive?.id) {
    assertBusinessSuccess(
      await api.putBusiness('/iot/alert-record/close', {
        id: nextActive.id,
        remark: `${IOT_E2E_PREFIX} second cycle closed`
      }),
      `关闭第二告警周期 id=${nextActive.id}`
    )
  }
  caseRecord.notes.push(
    '告警记录没有删除接口；E2E 将专属告警关闭作为审计保留事实，finally 清理模板、场景规则、告警配置、设备、物模型和产品。' +
      '本轮不调用转工单接口，因为正式工单 ID 未由本 IoT 夹具创建。'
  )
  markIotAssertion(caseRecord, 0, [
    '告警配置正式回读持续/组合/抑制/升级字段'
  ])
  markIotAssertion(caseRecord, 1, [
    '同一设备点位配置仅保留一条活动告警',
    '解除关闭后活动键释放'
  ])
  markIotAssertion(caseRecord, 2, [
    '告警确认/解除/关闭记录责任人、时间和正式处置说明'
  ], '未创建正式维护工单，无法证明 WORK_ORDER 阶段；服务端允许活动状态直接解除/关闭，完整线性状态机保留 GAP。')
  markIotAssertion(caseRecord, 3, [
    '告警确认/解除/关闭记录责任人、时间和正式处置说明'
  ], '确认与转工单接口没有持久化处置说明，且转工单未验证真实工单归属；本轮不以请求参数作为持久化事实。')
  return { product, device, identifier, configId, sceneRuleId, template, alert: closed }
}

export const createIotRuntimeStatusFixture = async (api, fixtures, device) => {
  const deviceId = strictId(device?.id, 'IoT 运行状态所属设备')
  requireIotE2eName(device?.deviceName, 'IoT 运行状态所属设备')
  const owned = dataOf(await api.getBusiness(`/iot/device/get?id=${deviceId}`))
  if (String(owned?.id) !== deviceId || owned?.deviceName !== device.deviceName ||
      String(owned.productId) !== String(device.productId)) {
    throw new Error('BLOCKED: MES 运行状态只允许绑定本轮专属设备')
  }
  const activePath = `/mes/device-status-event/active?deviceId=${deviceId}&coreLayer=RUNTIME`
  if (dataOf(await api.getBusiness(activePath)) != null) {
    throw new Error('BLOCKED: 专属设备已有运行状态，拒绝覆盖')
  }
  const reason = iotE2eMarker('013-RUNTIME')
  const belongsToFixture = (event, id) =>
    String(event?.id) === id && String(event.deviceId) === deviceId &&
    event.deviceName === device.deviceName && event.coreLayer === 'RUNTIME' &&
    event.statusCode === 'RUNNING' && event.sourceType === 'MANUAL' && event.reason === reason
  const eventId = fixtures.track(
    await api.postBusiness('/mes/device-status-event/start', {
      deviceId, deviceName: device.deviceName, coreLayer: 'RUNTIME',
      statusCode: 'RUNNING', sourceType: 'MANUAL', reason
    }),
    'MES 运行状态事件',
    async (id) => {
      const path = `/mes/device-status-event/get?id=${id}`
      const before = dataOf(await api.getBusiness(path))
      if (!belongsToFixture(before, id)) {
        throw new Error('MES 运行状态清理身份不一致，拒绝结束其他事件')
      }
      if (!before.endTime) {
        assertBusinessSuccess(
          await api.putBusiness('/mes/device-status-event/end', { id, reason }),
          '结束本轮 MES 运行状态'
        )
      }
      const ended = dataOf(await api.getBusiness(path))
      const active = dataOf(await api.getBusiness(activePath))
      if (!belongsToFixture(ended, id) || !ended.endTime || ended.active !== false || active != null) {
        throw new Error('MES 运行状态结束回读失败或活动键未释放')
      }
      return { retained: true, reason: '已正式结束并释放活动键；历史状态事件保留审计' }
    }
  )
  const event = dataOf(await api.getBusiness(`/mes/device-status-event/get?id=${eventId}`))
  const active = dataOf(await api.getBusiness(activePath))
  if (!belongsToFixture(event, eventId) || !event.startTime || event.endTime != null ||
      event.active !== true || !isDeepStrictEqual(event, active)) {
    throw new Error('MES 运行状态夹具未形成精确绑定设备的非空活动事实')
  }
  return event
}

export const sameIotRuntimeStatus = (before, after, fixture) =>
  fixture?.id != null && fixture?.deviceId != null && fixture.coreLayer === 'RUNTIME' &&
  fixture.statusCode === 'RUNNING' && fixture.active === true && fixture.endTime == null &&
  Boolean(fixture.startTime) && isDeepStrictEqual(before, fixture) && isDeepStrictEqual(after, fixture)

export const verifyIotAccessConfigVersions = async (api, product, caseRecord) => {
  const initialVersion = product.accessConfigVersion
  const changes = [
    ['deviceType', product.deviceType === 0 ? 2 : 0],
    ['netType', product.netType === 0 ? 2 : 0],
    ['protocolType', product.protocolType === 'mqtt' ? 'http' : 'mqtt'],
    ['serializeType', product.serializeType === 'json' ? 'binary' : 'json']
  ]
  let current = product
  for (const [field, value] of changes) {
    const before = current
    current = await updateIotProductFixture(api, before, { [field]: value })
    const passed = current?.[field] === value &&
      current.accessConfigVersion === before.accessConfigVersion + 1 &&
      changes.every(([other]) => other === field || current[other] === before[other])
    caseRecord.checks.push({
      name: `产品接入字段 ${field} 单独变化时版本精确递增`,
      passed,
      details: `${before.accessConfigVersion}->${current?.accessConfigVersion}; ${field}=${value}`
    })
    if (!passed) throw new Error(`产品 ${field} 更新或接入配置版本回读不一致`)
  }
  current = await updateIotProductFixture(api, current,
    Object.fromEntries(changes.map(([field]) => [field, product[field]])))
  const restored = current.accessConfigVersion === initialVersion + 5 &&
    changes.every(([field]) => current[field] === product[field])
  const sameValue = await updateIotProductFixture(api, current, {})
  const unchanged = sameValue.accessConfigVersion === current.accessConfigVersion &&
    changes.every(([field]) => sameValue[field] === current[field])
  caseRecord.checks.push({
    name: '产品接入配置变化时 accessConfigVersion 精确递增',
    passed: restored && unchanged,
    details: `product=${product.id}; initial=${initialVersion}; restored=${current.accessConfigVersion}; noOp=${sameValue.accessConfigVersion}; fourFields=${changes.map(([field]) => field).join(',')}`
  })
  if (!restored || !unchanged) throw new Error('产品接入字段恢复或同值更新版本契约不一致')
  return sameValue
}

export const runIotDeviceConfigClosure = async ({
  api,
  fixtures,
  caseRecord,
  page,
  outputDir,
  record,
  openRoute,
  saveScreenshot
}) => {
  const product = await createIotProductFixture(api, fixtures, {
    marker: iotE2eMarker('013-PRODUCT')
  })
  const initialVersion = Number(product.accessConfigVersion)
  if (initialVersion !== 1) {
    throw new Error(`新建产品 accessConfigVersion 必须为 1，实际 ${product.accessConfigVersion}`)
  }
  const updated = await verifyIotAccessConfigVersions(api, product, caseRecord)

  const device = await createIotDeviceFixture(api, fixtures, updated, {
    marker: iotE2eMarker('013-DEVICE')
  })
  const snapshot = parseDeviceSnapshot(device, caseRecord)
  const laterProduct = await updateIotProductFixture(api, updated, {
    protocolType: updated.protocolType === 'mqtt' ? 'http' : 'mqtt'
  })
  const persistedDevice = dataOf(await api.getBusiness(`/iot/device/get?id=${device.id}`))
  caseRecord.checks.push({
    name: '产品再次变更后既有设备仍保存原模型快照及接入版本',
    passed: laterProduct.accessConfigVersion === updated.accessConfigVersion + 1 &&
      persistedDevice?.productModelSnapshot === device.productModelSnapshot &&
      persistedDevice?.accessConfigVersion === device.accessConfigVersion,
    details: `productVersion=${laterProduct.accessConfigVersion}; deviceVersion=${persistedDevice?.accessConfigVersion}; snapshotVersion=${snapshot.accessConfigVersion}`
  })
  const runtimeFixture = await createIotRuntimeStatusFixture(api, fixtures, device)
  caseRecord.checks.push({
    name: '新设备快照保存更新后的产品接入版本',
    passed:
      snapshot.accessConfigVersion === updated.accessConfigVersion &&
      String(snapshot.productId) === String(updated.id),
    details: `device=${device.id}, snapshotVersion=${snapshot.accessConfigVersion}`
  })

  const invalidResponse = await api.request('PUT', '/iot/device/asset-status', {
    id: device.id,
    assetStatus: 'NOT_A_STATUS',
    reason: `${IOT_E2E_PREFIX} invalid`
  }, {
    expectedBusinessRejection: {
      code: 400,
      message: /^非法设备资产状态/
    }
  })
  const invalidRejected = matchesExpectedBusinessRejection(invalidResponse, {
    code: 400,
    message: /^非法设备资产状态/
  })
  const before = dataOf(await api.getBusiness(`/iot/device/get?id=${encodeURIComponent(device.id)}`))
  caseRecord.checks.push({
    name: '非法资产状态精确拒绝且设备完整事实不变',
    passed: invalidRejected && isDeepStrictEqual(persistedDevice, before),
    details: `code=${invalidResponse?.code}; unchanged=${isDeepStrictEqual(persistedDevice, before)}`
  })
  const runtimeBefore = dataOf(await api.getBusiness(
    `/mes/device-status-event/active?deviceId=${encodeURIComponent(device.id)}&coreLayer=RUNTIME`
  ))
  assertBusinessSuccess(
    await api.putBusiness('/iot/device/asset-status', {
      id: device.id,
      assetStatus: 'DISABLED',
      reason: `${IOT_E2E_PREFIX} asset state`
    }),
    '设备资产状态切换'
  )
  const after = dataOf(await api.getBusiness(`/iot/device/get?id=${encodeURIComponent(device.id)}`))
  const runtimeAfter = dataOf(await api.getBusiness(
    `/mes/device-status-event/active?deviceId=${encodeURIComponent(device.id)}&coreLayer=RUNTIME`
  ))
  const runtimeProtected = sameIotRuntimeStatus(runtimeBefore, runtimeAfter, runtimeFixture)
  const stateSeparated =
    invalidRejected &&
    before.assetStatus === 'ENABLED' &&
    after.assetStatus === 'DISABLED' &&
    after.state === before.state &&
    runtimeProtected
  caseRecord.checks.push({
    name: '非法资产状态被拒绝且合法切换不覆盖连接/运行状态',
    passed: stateSeparated,
    details:
      `invalidRejected=${invalidRejected}, asset=${before.assetStatus}->${after.assetStatus}, ` +
      `connection=${after.state}, runtimeEvent=${runtimeFixture.id}, runtimeProtected=${runtimeProtected}`
  })
  caseRecord.checks.push({
    name: 'MES RUNTIME 非空状态在资产状态切换前后保持不变',
    passed: runtimeProtected,
    details: `eventId=${runtimeFixture.id}; deviceId=${device.id}; coreLayer=RUNTIME; statusCode=RUNNING`
  })

  await openRoute(page, `/iot/device/detail/${encodeURIComponent(device.id)}`, {
    readyText: '设备详情'
  })
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '设备详情真实路由展示专属设备',
    passed: bodyText.includes(device.deviceName) && bodyText.includes('连接状态'),
    details: `deviceId=${device.id}, version=${after.accessConfigVersion}`
  })
  const deviceInfo = page.locator('.el-descriptions').filter({ hasText: 'DeviceName' })
  const valueFor = async (label) => deviceInfo.locator('tr')
    .filter({ has: page.locator('.el-descriptions__label').filter({ hasText: label }) })
    .locator('.el-descriptions__label').filter({ hasText: label })
    .evaluate((element) => element.nextElementSibling?.textContent?.replace(/\s+/g, ' ').trim() || '')
  const displayedAsset = await valueFor('资产状态')
  const displayedVersion = await valueFor('接入配置版本')
  const displayedSnapshot = await valueFor('产品模型快照')
  caseRecord.checks.push({
    name: '设备详情分别展示真实资产状态、接入版本及保存的模型快照',
    passed: displayedAsset === '停用' && displayedVersion === String(after.accessConfigVersion) &&
      displayedSnapshot === `v${snapshot.accessConfigVersion} · ${snapshot.protocolType} / ${snapshot.serializeType}`,
    details: `asset=${displayedAsset}; version=${displayedVersion}; snapshot=${displayedSnapshot}`
  })
  await saveScreenshot(page, outputDir, 'iot-013-device-config', record)
  markIotAssertion(caseRecord, 0, [
    '非法资产状态被拒绝且合法切换不覆盖连接/运行状态',
    'MES RUNTIME 非空状态在资产状态切换前后保持不变',
    'MES 运行状态事件隔离夹具已保留',
    '设备详情分别展示真实资产状态、接入版本及保存的模型快照'
  ])
  markIotAssertion(caseRecord, 1, [
    '非法资产状态精确拒绝且设备完整事实不变',
    '非法资产状态被拒绝且合法切换不覆盖连接/运行状态',
    'IoT 设备测试数据已清理'
  ])
  markIotAssertion(caseRecord, 2, [
    '设备产品模型快照为完整对象并精确绑定产品与接入版本',
    '新设备快照保存更新后的产品接入版本',
    '产品再次变更后既有设备仍保存原模型快照及接入版本'
  ])
  markIotAssertion(caseRecord, 3, [
    '产品接入配置变化时 accessConfigVersion 精确递增'
  ])
  return { product, device, initialVersion, updated }
}

export const runIotDeadLetterClosure = async ({
  api,
  fixtures,
  caseRecord,
  page,
  outputDir,
  record,
  openRoute,
  saveScreenshot
}) => {
  const product = await createIotProductFixture(api, fixtures, {
    marker: iotE2eMarker('011-PRODUCT')
  })
  const identifier = 'e2e_011_signal'
  await createIotPropertyFixture(api, fixtures, product, {
    identifier,
    name: iotE2eMarker('011-PROPERTY')
  })
  await publishIotProductFixture(api, product)
  const device = await createIotDeviceFixture(api, fixtures, product, {
    marker: iotE2eMarker('011-DEVICE')
  })
  const sinkId = fixtures.track(
    await api.postBusiness('/iot/data-sink/create', {
      name: iotE2eMarker('011-SINK'),
      description: `${IOT_E2E_PREFIX} unreachable http sink`,
      status: 0,
      type: 1,
      config: {
        type: '1',
        url: 'http://127.0.0.1:1/e2e-iot-dead-letter',
        method: 'POST',
        headers: {},
        query: {},
        body: '{}'
      }
    }),
    'IoT HTTP 数据目的',
    async (id) => {
      const existing = dataOf(await api.getBusiness(`/iot/data-sink/get?id=${encodeURIComponent(id)}`))
      if (!existing) return
      requireIotE2eName(existing.name, 'IoT HTTP 数据目的清理')
      assertBusinessSuccess(
        await api.deleteBusiness(`/iot/data-sink/delete?id=${encodeURIComponent(id)}`),
        `IoT HTTP 数据目的清理 id=${id}`
      )
    }
  )
  fixtures.track(
    await api.postBusiness('/iot/data-rule/create', {
      name: iotE2eMarker('011-RULE'),
      description: `${IOT_E2E_PREFIX} isolated rule`,
      status: 0,
      sourceConfigs: [{
        method: 'thing.property.post',
        productId: product.id,
        deviceId: device.id,
        // PROPERTY_POST identifier is not populated by the current message utility.
        identifier: null
      }],
      sinkIds: [sinkId]
    }),
    'IoT 数据流转规则',
    async (id) => {
      const existing = dataOf(await api.getBusiness(`/iot/data-rule/get?id=${encodeURIComponent(id)}`))
      if (!existing) return
      requireIotE2eName(existing.name, 'IoT 数据流转规则清理')
      assertBusinessSuccess(
        await api.deleteBusiness(`/iot/data-rule/delete?id=${encodeURIComponent(id)}`),
        `IoT 数据流转规则清理 id=${id}`
      )
    }
  )
  await sendProperty(api, device, identifier, {
    value: 88,
    reportTime: new Date().toISOString().slice(0, 19),
    sequenceNo: 11001
  })
  const deadLetters = await waitForCondition(
    async () => pageOf(await api.getBusiness(
      `/iot/write-back-dead-letter/page?pageNo=1&pageSize=100&deviceId=${encodeURIComponent(device.id)}`
    )).list,
    (rows) => rows.length === 1,
    { label: '回写死信登记', timeoutMs: 20000 }
  )
  const deadLetter = deadLetters[0]
  caseRecord.checks.push({
    name: 'HTTP 数据目的真实失败后登记唯一 E2E 死信',
    passed:
      deadLetter.bizType === 'DATA_SINK' &&
      String(deadLetter.refId) === String(sinkId) &&
      String(deadLetter.deviceId) === String(device.id) &&
      deadLetter.identifier == null &&
      deadLetter.idempotentKey.includes(`${device.id}:`) &&
      deadLetter.idempotentKey.includes(`sink:${sinkId}`) &&
      Boolean(deadLetter.lastError) &&
      Boolean(deadLetter.sourceTime),
    details: `deadLetter=${deadLetter.id}, sink=${sinkId}, device=${device.id}`
  })
  assertBusinessSuccess(
    await api.putBusiness('/iot/write-back-dead-letter/handle', {
      id: deadLetter.id,
      handleRemark: `${IOT_E2E_PREFIX} 人工接管`
    }),
    '回写死信人工接管'
  )
  const handled = dataOf(await api.getBusiness(
    `/iot/write-back-dead-letter/get?id=${encodeURIComponent(deadLetter.id)}`
  ))
  caseRecord.checks.push({
    name: '死信人工接管记录接管人、时间与说明',
    passed:
      handled.status === 'HANDLED' &&
      handled.handleUserId != null &&
      Boolean(handled.handleTime) &&
      handled.handleRemark === `${IOT_E2E_PREFIX} 人工接管`,
    details: `deadLetter=${deadLetter.id}, status=${handled.status}`
  })
  await openRoute(page, '/iot/device/write-back-dead-letter', {
    readyText: '最近失败原因'
  })
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '回写死信页面展示专属死信和最近失败原因',
    passed:
      bodyText.includes('回写死信队列') &&
      bodyText.includes('最近失败原因') &&
      bodyText.includes(String(deadLetter.id)),
    details: `route=/iot/device/write-back-dead-letter, deadLetter=${deadLetter.id}`
  })
  await saveScreenshot(page, outputDir, 'iot-011-dead-letter', record)
  caseRecord.notes.push(
    '回写死信没有删除接口；E2E 将专属死信人工接管后保留为审计事实，finally 只清理规则、目的、设备、物模型和产品。'
  )
  markIotAssertion(caseRecord, 0, [
    'HTTP 数据目的真实失败后登记唯一 E2E 死信'
  ], '本轮证明 DATA_SINK 投递失败登记；UNKNOWN_DEVICE 需要网关/MQ 入口，管理员发送接口会先拒绝不存在设备。')
  markIotAssertion(caseRecord, 1, [
    'HTTP 数据目的真实失败后登记唯一 E2E 死信'
  ], '正式管理员发送每次生成新 messageId，未找到同一死信幂等键重投入口；只记录来源版本与失败原因。')
  markIotAssertion(caseRecord, 2, [
    '死信人工接管记录接管人、时间与说明'
  ], '未发现正式 retry executor/job 的可观察状态流转，RETRYING/DEAD_LETTER 状态保留 GAP。')
  markIotAssertion(caseRecord, 3, [
    '死信人工接管记录接管人、时间与说明'
  ])
  return { partial: true, product, device, identifier, sinkId, deadLetter: handled }
}

export const runIotSecurityE2e = async ({
  caseId,
  api,
  fixtures,
  caseRecord,
  page,
  outputDir,
  record,
  openRoute,
  saveScreenshot
}, dependencies = {}) => {
  const context = { api, fixtures, caseRecord, page, outputDir, record, openRoute, saveScreenshot }
  if (caseId === 'IOT-002') {
    const result = await runIotAnomalyClosure(context)
    const permissionEvidence = await verifyIotPermissionRejections({
      adminApi: api,
      device: result.device,
      identifier: result.identifier,
      caseRecord,
      record,
      runtime: dependencies.runtime || config
    }, dependencies)
    return { ...result, permissionEvidence }
  }
  if (caseId === 'IOT-009') return runIotAnomalyClosure(context)
  if (caseId === 'IOT-010') return runIotAlertLifecycleClosure(context)
  if (caseId === 'IOT-011') return runIotDeadLetterClosure(context)
  if (caseId === 'IOT-013') return runIotDeviceConfigClosure(context)
  return { partial: true, note: `IOT 写侧夹具未覆盖 ${caseId}` }
}
