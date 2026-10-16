import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { assertBusinessSuccess, isBusinessSuccess } from '../lib/assertions.mjs'
import { createApiClient } from '../lib/api.mjs'
import { launchBrowser, loginWithCredentials, saveScreenshot } from '../lib/browser.mjs'
import { createProcurementPermissionReader } from './procurement-permission-reader.mjs'

export const QUALITY_PERMISSION_FORBIDDEN = Object.freeze({
  code: 403,
  message: '没有该操作权限'
})

const stableId = (value) => /^[1-9]\d*$/.test(String(value ?? ''))
const dataOf = (response, label) => assertBusinessSuccess(response, label).data
const basePath = '/mes/quality-ng-type'
const saveFields = [
  'name', 'code', 'status', 'operationType', 'defectType', 'defectLevel',
  'procedureId', 'remark', 'parentId', 'responsibleDomain', 'defaultHandleMethod', 'sortOrder'
]

const exactForbidden = (response) => {
  const messages = [response?.msg, response?.message]
    .filter((value) => typeof value === 'string' && value.trim())
  return response?.code === QUALITY_PERMISSION_FORBIDDEN.code &&
    !isBusinessSuccess(response) && response.success !== true && response.ok !== true &&
    response.data == null &&
    messages.length > 0 &&
    messages.every((message) => message === QUALITY_PERMISSION_FORBIDDEN.message)
}

async function readQualityState(adminApi, ngTypeId, itemId, probeCode) {
  const row = dataOf(await adminApi.getBusiness(
    `${basePath}/get?id=${encodeURIComponent(ngTypeId)}`
  ), '质量权限验收主档回读')
  const relations = dataOf(await adminApi.getBusiness(
    `${basePath}/item-relations?itemId=${encodeURIComponent(itemId)}`
  ), '质量权限验收关系回读')
  if (!Array.isArray(relations) || !relations.every(stableId) ||
      new Set(relations.map(String)).size !== relations.length) {
    throw new Error('质量权限验收关系回读格式无效')
  }
  const page = dataOf(await adminApi.getBusiness(
    `${basePath}/page?pageNo=1&pageSize=100&code=${encodeURIComponent(probeCode)}`
  ), '质量权限验收创建探针回读')
  const rows = page?.list ?? page?.records
  if (!Array.isArray(rows) || !Number.isSafeInteger(page?.total) ||
      page.total !== rows.length || rows.length > 100 ||
      !rows.every((entry) => entry && typeof entry.code === 'string')) {
    throw new Error('质量权限验收创建探针分页无效或不完整')
  }
  return structuredClone({
    row,
    relations: relations.map(String).sort(),
    probeAbsent: !rows.some((entry) => entry.code === probeCode)
  })
}

/**
 * Verify NG master and item-relation permissions with one isolated reader login.
 * Only the account is deactivated; its read-only role remains as audit evidence.
 */
export async function verifyQualityNgTypePermissionRejections({
  adminApi,
  record,
  caseRecord,
  outputDir,
  ngType,
  itemId,
  headed = false,
  permission = 'erp:settle-method-rule:query'
}, dependencies = {}) {
  if (!adminApi || !caseRecord || !stableId(ngType?.id) || !stableId(itemId) ||
      String(ngType?.row?.id) !== String(ngType.id) ||
      !/^E2E-/.test(ngType?.row?.code || '')) {
    throw new Error('BLOCKED: 质量权限负向验收必须使用本轮专属 NG 主档和稳定项目 ID')
  }
  if (typeof permission !== 'string' || !permission.endsWith(':query') ||
      permission.includes('*') || permission.startsWith('mes:quality')) {
    throw new Error('BLOCKED: 质量权限验收账号只能授予非质量查询权限')
  }
  caseRecord.checks ||= []
  caseRecord.notes ||= []
  caseRecord.evidence ||= []
  const checks = []
  const check = (name, passed, details = '') => {
    const entry = { name, passed: Boolean(passed), details }
    checks.push(entry)
    caseRecord.checks.push(entry)
    return entry.passed
  }
  const probeCode = `E2E-Q-PERM-${randomBytes(6).toString('hex')}`
  const before = await readQualityState(adminApi, ngType.id, itemId, probeCode)
  if (!before.probeAbsent || String(before.row?.id) !== String(ngType.id) ||
      before.row?.code !== ngType.row.code || !before.row?.name ||
      !Number.isSafeInteger(before.row?.status)) {
    throw new Error('BLOCKED: 质量权限验收主档归属或创建探针基线不匹配')
  }
  const saveBody = Object.fromEntries(saveFields
    .filter((field) => before.row[field] !== undefined)
    .map((field) => [field, before.row[field]]))
  const relationChange = before.relations.includes(String(ngType.id))
    ? before.relations.filter((id) => id !== String(ngType.id))
    : [...before.relations, String(ngType.id)]
  let reader
  let isolated
  let failure
  const cleanupErrors = []
  const secrets = []
  const safeMessage = (error) => secrets.reduce((text, secret) =>
    secret ? text.split(secret).join('[REDACTED]') : text,
  String(error?.message || error))
    .replace(/(^|[\s:=])([A-Za-z0-9._-]*token[A-Za-z0-9._-]*)(?=$|[\s;])/gi,
      '$1[REDACTED]')
  const results = []
  let unchanged
  let screenshot

  try {
    reader = await (dependencies.createProcurementPermissionReader || createProcurementPermissionReader)(
      adminApi, caseRecord, { permission, label: 'QUALITYB005' }
    )
    secrets.push(reader.credentials?.password)
    if (!stableId(reader.userId) || !stableId(reader.roleId) ||
        !reader.username || reader.credentials?.username !== reader.username) {
      throw new Error('BLOCKED: 质量只读验收账号身份不完整')
    }
    isolated = await (dependencies.launchBrowser || launchBrowser)({ headed, record })
    if (isolated.page?.url() !== 'about:blank') {
      throw new Error('BLOCKED: 质量权限账号必须在全新隔离浏览器页面登录')
    }
    const token = await (dependencies.loginWithCredentials || loginWithCredentials)(
      isolated.page, reader.credentials
    )
    if (typeof token !== 'string' || !token) throw new Error('质量只读账号登录未返回 token')
    secrets.push(token)
    const readerApi = (dependencies.createApiClient || createApiClient)({ token, record })
    const info = dataOf(await readerApi.getBusiness('/system/auth/get-permission-info'),
      '质量只读账号真实权限回读')
    const identityVerified = info?.user?.username === reader.username &&
      Array.isArray(info?.permissions) &&
      info.permissions.includes(permission) &&
      info.permissions.every((value) => typeof value === 'string' &&
        !value.includes('*') && !value.startsWith('mes:quality'))
    if (!check('隔离只读账号真实用户名匹配且不具备质量或通配权限', identityVerified,
      `username=${info?.user?.username}; userId=${reader.userId}; roleId=${reader.roleId}`)) {
      throw new Error('BLOCKED: 质量权限验收账号真实身份或权限不符合只读约束')
    }
    const requests = [
      ['create', 'POST', `${basePath}/create`,
        { ...saveBody, code: probeCode, name: `${probeCode}-CREATE`, remark: probeCode }],
      ['update', 'PUT', `${basePath}/update`,
        { ...saveBody, id: String(ngType.id), name: `${probeCode}-UPDATE` }],
      ['delete', 'DELETE', `${basePath}/delete?id=${encodeURIComponent(ngType.id)}`],
      ['get', 'GET', `${basePath}/get?id=${encodeURIComponent(ngType.id)}`],
      ['page', 'GET', `${basePath}/page?pageNo=1&pageSize=100`],
      ['export-excel', 'GET', `${basePath}/export-excel?pageNo=1&pageSize=100`],
      ['item-relations GET', 'GET',
        `${basePath}/item-relations?itemId=${encodeURIComponent(itemId)}`],
      ['item-relations PUT', 'PUT', `${basePath}/item-relations`,
        { itemId: String(itemId), ngTypeIds: relationChange }]
    ]
    for (const [label, method, pathname, body] of requests) {
      // Use the JSON request path for export rejection, not the Excel downloader.
      const response = await readerApi.request(method, pathname, body)
      const passed = check(`无质量权限账号 ${label} 被精确 403 拒绝`, exactForbidden(response),
        `${method} ${pathname}; code=${response?.code}; expected=403/没有该操作权限`)
      results.push({ label, method, pathname, code: response?.code, passed })
    }
    if (outputDir) {
      screenshot = await (dependencies.saveScreenshot || saveScreenshot)(
        isolated.page, outputDir, 'quality-ng-type-permission-account', record
      )
    }
  } catch (error) {
    failure = error
  } finally {
    try {
      const after = await readQualityState(adminApi, ngType.id, itemId, probeCode)
      unchanged = {
        ngType: isDeepStrictEqual(before.row, after.row),
        relations: isDeepStrictEqual(before.relations, after.relations),
        createProbeAbsent: before.probeAbsent && after.probeAbsent
      }
      check('管理员前后回读主档未改删、关系未改写且拒绝创建未落库',
        Object.values(unchanged).every(Boolean),
        `ngTypeId=${ngType.id}; itemId=${itemId}; ${JSON.stringify(unchanged)}`)
    } catch (error) {
      check('管理员前后回读未完成，不能认定权限拒绝无副作用', false)
      cleanupErrors.push(`管理员回读失败：${safeMessage(error)}`)
    }
    if (reader) {
      try {
        assertBusinessSuccess(await reader.deactivate(), '停用质量权限验收账号')
        const user = dataOf(await adminApi.getBusiness(
          `/system/user/get?id=${encodeURIComponent(reader.userId)}`
        ), '质量权限验收账号停用回读')
        if (String(user?.id) !== String(reader.userId) ||
            user?.username !== reader.username || Number(user?.status) !== 1) {
          throw new Error('质量权限验收账号停用状态或身份回读不匹配')
        }
        check('验收账号 finally 停用并回读确认，只读角色保留审计', true,
          `userId=${reader.userId}; roleId=${reader.roleId}; status=1`)
        caseRecord.notes.push(`质量权限验收账号 ${reader.username}(${reader.userId}) 已停用；只读角色 ${reader.roleId} 保留作权限审计。`)
      } catch (error) {
        check('质量权限验收账号停用失败', false)
        cleanupErrors.push(`停用账号失败：${safeMessage(error)}`)
      }
    }
    if (isolated?.browser) {
      try {
        await isolated.browser.close()
      } catch (error) {
        check('隔离质量权限浏览器关闭失败', false)
        cleanupErrors.push(`关闭浏览器失败：${safeMessage(error)}`)
      }
    }
  }
  if (failure || cleanupErrors.length) {
    throw new Error([failure && safeMessage(failure), ...cleanupErrors].filter(Boolean).join('；'))
  }
  const verified = results.length === 8 && checks.every((entry) => entry.passed)
  caseRecord.evidence.push(`质量权限负向 API 验收：账号=${reader.username}；8 接口精确 403=${verified}；NG=${ngType.id}；项目=${itemId}；主档/关系/创建探针均由管理员前后回读对照；不含跨租户验收。`)
  return {
    verified,
    results,
    unchanged,
    evidence: {
      exactForbidden: results.every((entry) => entry.passed),
      unchanged,
      accountDeactivated: true,
      auditRoleId: reader.roleId
    },
    account: { userId: reader.userId, username: reader.username, roleId: reader.roleId },
    ...(screenshot ? { screenshot } : {})
  }
}
