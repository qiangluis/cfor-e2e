import { OWNED_CATALOG_ASSERTIONS } from '../workbenchhelper/contracts.mjs'
import { isWorkbenchWriteFixturesEnabled } from '../workbenchhelper/fixture.mjs'
import { assertWriteTestSnapshot } from '../lib/db.mjs'

const REPORT_CASES = new Set(['WBF-004', 'WBF-008'])
const COMMON_CHECKS = [
  ['专属成员真实创建、提交日报并回读非空来源快照', 1],
  ['所有者工作台返回本轮三类非空报告', 1],
  ['项目经理审核日报并回读明细与锁定状态', 1]
]

export const WORKBENCH_REPORT_CLOSURE_CHECKS = Object.freeze({
  'WBF-004': [
    ...COMMON_CHECKS,
    ...['日报', '周报', '月报'].map((label) =>
      [`${label}实际切换并匹配当前用户真实响应（PB-359~365）`, 1]),
    ['工作报告区块保持在统一门户内', 1],
    ['非项目成员不能读取他人日报或项目报告分页', 6],
    ['受限账号伪造他人填报人筛选仍不能读到报告', 9],
    ['未来生效项目角色不能读取他人报告', 1],
    ['已过期项目角色不能读取他人报告', 1],
    ['旁观账号工作台三类报告均与非空所有者隔离', 1]
  ],
  'WBF-008': [
    ...COMMON_CHECKS,
    ['三类提醒精确匹配正式 API 已填/未填/待审批口径', 1],
    ['草稿提醒不得被称为已提交', 1],
    ['周报格式 UI 保存精确字段', 1],
    ['system_user_preference 按专属用户/租户落库', 1],
    ['刷新后周报格式回显已保存字段', 1],
    ['专属用户偏好不修改管理员偏好', 1],
    ['专属偏好最终基线还原：workbench.report.weekly-metrics', 1]
  ]
})

export function workbenchReportMode (caseId, env = process.env) {
  if (!REPORT_CASES.has(caseId)) return null
  const writeFixtures = isWorkbenchWriteFixturesEnabled(env)
  const dailyClosure = env.CFOR_E2E_WORKBENCH_DAILY_CLOSURE === 'true'
  const dailyGaps = env.CFOR_E2E_WORKBENCH_DAILY_GAPS === 'true'
  if (dailyClosure && dailyGaps) throw new Error('BLOCKED: 日报闭环与只读缺口模式不能同时启用')
  if ((dailyClosure || dailyGaps) && !writeFixtures) {
    throw new Error('BLOCKED: 日报专属模式必须同时显式设置 CFOR_E2E_WRITE_FIXTURES=true')
  }
  return {
    mode: dailyClosure ? 'daily-closure' : dailyGaps ? 'daily-gaps'
      : writeFixtures ? 'owned-crm-only' : 'read-only',
    writeFixtures, dailyClosure, dailyGaps,
    requiredClosureFlags: {
      CFOR_E2E_WRITE_FIXTURES: 'true',
      CFOR_E2E_WORKBENCH_DAILY_CLOSURE: 'true'
    }
  }
}

// Existing fixture checks remain authoritative; this audit cannot invent evidence.
export function finalizeWorkbenchReportClosure (caseId, caseRecord, result) {
  const requirements = WORKBENCH_REPORT_CLOSURE_CHECKS[caseId]
  if (!requirements) throw new Error(`未定义工作台日报闭环验收：${caseId}`)
  const gaps = [...(caseRecord.remainingAssertions || [])]
  const checks = caseRecord.checks || []
  const rows = caseRecord.catalogAssertions || []
  const expected = OWNED_CATALOG_ASSERTIONS[caseId]
  const exact = rows.length === expected.length && expected.every((assertion, index) => {
    const row = rows[index]
    return row.caseId === caseId && row.index === index && row.assertion === assertion &&
      row.status === 'VERIFIED' && typeof row.evidence === 'string' && row.evidence.trim()
  })
  if (!exact) gaps.push('原 catalog 断言的顺序、同文映射或本轮证据不完整')
  const mode = caseRecord.workbenchReportMode
  if (mode?.mode !== 'daily-closure' || mode.writeFixtures !== true ||
    mode.dailyClosure !== true || mode.dailyGaps !== false) gaps.push('未执行显式 opt-in 日报闭环模式')
  for (const [name, count] of requirements) {
    const matched = checks.filter((row) => row.name === name)
    if (matched.length < count || matched.some((row) => row.passed !== true)) {
      gaps.push(`闭环门禁未证实：${name}（需${count}次）`)
    }
  }
  const preflight = caseRecord.database?.find((row) => row.stage === 'write-preflight')
  try {
    if (!preflight?.available) throw new Error('缺少数据库安全快照')
    assertWriteTestSnapshot(preflight.rows)
  } catch (error) {
    gaps.push(error.message)
  }
  const objects = caseRecord.fixtureObjects || []
  const cleanup = caseRecord.fixtureCleanup
  const marker = cleanup?.marker
  if (!new RegExp(`^E2E-WBF-${caseId.slice(-3)}-[A-Z0-9-]+$`).test(marker || '') ||
    !objects.length || !Array.isArray(cleanup?.remaining) || cleanup.remaining.length ||
    objects.some((row) => row.marker !== marker || !cleanup.cleaned?.some((cleaned) =>
      cleaned.type === row.type && String(cleaned.id) === String(row.id)))) {
    gaps.push('专属对象所有权与清理回读未完整闭环')
  }
  if (checks.some((row) => row.passed === false)) gaps.push('本轮存在失败断言')
  if (result?.partial || result?.blocked || result?.acceptanceComplete === false ||
    result?.catalogComplete !== true) gaps.push(result?.note || '原夹具未完成验收')
  caseRecord.remainingAssertions = [...new Set(gaps)]
  caseRecord.catalogComplete = Boolean(exact)
  caseRecord.acceptanceComplete = gaps.length === 0
  caseRecord.checks.push({
    name: '工作台原断言与日报闭环门禁完整',
    passed: caseRecord.acceptanceComplete,
    details: JSON.stringify({ mode, catalogCount: rows.length,
      gates: requirements.map(([name, count]) => ({ name, count })), gaps: caseRecord.remainingAssertions })
  })
  return {
    ...result,
    acceptanceComplete: caseRecord.acceptanceComplete,
    ...(gaps.length ? { partial: true, note: caseRecord.remainingAssertions.join('；') } : {})
  }
}
