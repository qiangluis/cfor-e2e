import { assertBusinessSuccess } from '../lib/assertions.mjs'

export const PROCUREMENT_REQUISITION_CONFIG_PATH =
  '/system/config/get?category=purchase&tag=requisition'
export const PROCUREMENT_DIRECT_CREATE_PERMISSION = 'erp:purchase-order:direct-create'
export const PROCUREMENT_SUPER_PERMISSION = '*:*:*'

const dataOf = (payload, label) => assertBusinessSuccess(payload, label).data

const blocked = (caseId, message) =>
  new Error(`BLOCKED: ${caseId} ${message}`)

function parseBooleanValue (value) {
  if (typeof value === 'boolean') return { valid: true, enabled: value }
  if (typeof value === 'number' && (value === 0 || value === 1)) {
    return { valid: true, enabled: value === 1 }
  }
  if (typeof value !== 'string') return { valid: false }
  const normalized = value.trim().toLowerCase()
  if (['true', '1'].includes(normalized)) return { valid: true, enabled: true }
  if (['false', '0'].includes(normalized)) return { valid: true, enabled: false }
  return { valid: false }
}

export function parseProcurementRequisitionConfig (option) {
  if (option === null || option === undefined) {
    return { valid: true, enabled: false, source: 'missing' }
  }
  if (!option || typeof option !== 'object' || Array.isArray(option) ||
      !Object.prototype.hasOwnProperty.call(option, 'configData')) {
    return { valid: false, reason: '请购配置响应缺少 configData' }
  }
  const raw = option.configData
  if (raw === null || raw === undefined ||
      (typeof raw === 'string' && raw.trim() === '')) {
    return { valid: true, enabled: false, source: 'empty' }
  }

  const direct = parseBooleanValue(raw)
  if (direct.valid) return { ...direct, source: 'scalar' }
  if (typeof raw !== 'string') {
    return { valid: false, reason: '请购配置不是合法布尔值或 JSON 对象' }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { valid: false, reason: '请购配置 JSON 无法解析' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      !Object.prototype.hasOwnProperty.call(parsed, 'enabled')) {
    return { valid: false, reason: '请购配置 JSON 缺少 enabled' }
  }
  const enabled = parseBooleanValue(parsed.enabled)
  return enabled.valid
    ? { ...enabled, source: 'json' }
    : { valid: false, reason: '请购配置 enabled 不是合法布尔值' }
}

/**
 * Verify the existing direct-create permission before any procurement write.
 * The fixture never changes the option or grants permissions.
 */
export async function assertProcurementDirectCreateGate (
  api, caseId, { configPath = PROCUREMENT_REQUISITION_CONFIG_PATH } = {}
) {
  let option
  try {
    option = dataOf(await api.getBusiness(configPath), `${caseId} 请购开关`)
  } catch (error) {
    throw blocked(caseId, `请购开关读取失败，拒绝进入写侧：${error.message || error}`)
  }

  const parsed = parseProcurementRequisitionConfig(option)
  if (!parsed.valid) throw blocked(caseId, parsed.reason)
  if (!parsed.enabled) {
    return { requisitionEnabled: false, directCreatePermission: null }
  }

  let permissionInfo
  try {
    permissionInfo = dataOf(
      await api.getPermissionInfo(),
      `${caseId} 当前权限`
    )
  } catch (error) {
    throw blocked(caseId, `当前权限读取失败，拒绝进入写侧：${error.message || error}`)
  }
  if (!Array.isArray(permissionInfo?.permissions)) {
    throw blocked(caseId, '当前权限响应缺少 permissions 数组，拒绝进入写侧')
  }

  const directCreatePermission = permissionInfo.permissions.find((permission) =>
    permission === PROCUREMENT_SUPER_PERMISSION ||
    permission === PROCUREMENT_DIRECT_CREATE_PERMISSION
  )
  if (!directCreatePermission) {
    throw blocked(
      caseId,
      `请购开关已开启且当前账号没有 ${PROCUREMENT_DIRECT_CREATE_PERMISSION}，未创建任何采购夹具`
    )
  }
  return {
    requisitionEnabled: true,
    directCreatePermission
  }
}
