/**
 * Init-suite scope gates. These helpers keep read-only evidence separate from
 * mutations that require a disposable tenant or explicitly approved users.
 */
export const SAFE_READ_ONLY_CASES = new Set([
  'PB001-001',
  'PB002-001',
  'PB003-001',
  'PB005-001',
  'PB008-001',
  'PB009-001',
  'PB010-001',
  'PB011-001',
  'PB029-001',
  'PB032-001',
  'PB032-002',
  'PB032-003',
  'PB032-004',
  'PB032-005'
])

export const BLOCKED_UNSAFE_CASES = new Map([
  ['INIT-002', '初始化确认会写入租户启用范围、权限和菜单；需要新租户或用户确认，不得改当前共享租户'],
  ['INIT-003', '首轮预置 apply 会写入租户状态和业务配置；需要新租户或用户确认'],
  ['INIT-004', '页签/设置回读包含跳过期初、正式账套等状态写侧；需要新租户或用户确认'],
  ['INIT-005', '完整必配/可选边界需要改变或验证初始化事实与 Job 状态；当前共享租户禁止写入'],
  ['PB001-002', 'Logo 缺省自动生成需要修改企业资料或清空既有 Logo；需要新租户或用户确认'],
  ['PB004-001', '需要创建测试角色、测试用户并修改 system_user_role；需要用户/新租户前置'],
  ['PB007-001', '岗位唯一和引用删除保护需要创建测试岗位/用户关系；当前实现仅有只读步骤'],
  ['PB008-002', '邀请激活需要发送/接受测试邀请并创建用户；需要测试邮箱、用户确认和可清理租户'],
  ['PB032-006', '业务能力关闭会影响存货写侧门禁；需要可清理测试存货和用户确认']
])

export function markPartial(caseRecord, note) {
  caseRecord.notes.push(`只读证据已执行，完整写侧未执行：${note}`)
  return { partial: true, note }
}

export function markBlocked(caseRecord, caseId) {
  const reason = BLOCKED_UNSAFE_CASES.get(caseId) ||
    '当前没有安全、可回滚的真实前置，不能修改共享租户事实'
  caseRecord.notes.push(`BLOCKED：${reason}`)
  throw new Error(`BLOCKED: ${reason}`)
}

export function assertSafeCaseScope(caseRecord, caseId) {
  if (BLOCKED_UNSAFE_CASES.has(caseId)) return markBlocked(caseRecord, caseId)
  return null
}

export function listData(payload) {
  return payload?.data?.list || payload?.data?.records || payload?.result?.records ||
    (Array.isArray(payload?.data) ? payload.data : null)
}

export function successful(payload) {
  return payload?.code === 0 || (payload?.code === 200 && payload?.success === true)
}

export function scopeNote(caseId) {
  return SAFE_READ_ONLY_CASES.has(caseId)
    ? '当前实现只验证真实页面/API只读契约；写侧、幂等、权限反例和数据库前后值仍需测试租户。'
    : '当前实现未执行安全写侧。'
}
