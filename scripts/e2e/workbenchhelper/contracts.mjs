export const OWNED_CATALOG_ASSERTIONS = Object.freeze({
  'WBF-004': Object.freeze([
    '工作报告区块可见', '日报/周报/月报页签完整', '路由仍为 /index'
  ]),
  'WBF-005': Object.freeze([
    '两个采购快捷动作可见', '采购执行表弹窗可见', '路由仍为 /index'
  ]),
  'WBF-008': Object.freeze([
    '报告区块展示日报/周报/月报提醒',
    '提醒包含已填/未填与待审批口径',
    '周报格式按用户维度保存到 system_user_preference'
  ]),
  'WBF-009': Object.freeze([
    '登录权限信息下发 portalCode/portalSections',
    '工作台可见区块与命中的门户区块组合一致',
    '未配置门户时展示默认全部区块'
  ]),
  'WBF-012': Object.freeze([
    '工作报告区块提供统计入口',
    '统计表覆盖日报/周报/月报口径',
    '统计周期可切换（本月/本季度/本年度）',
    '统计范围可按本人/团队（后端数据权限）切换',
    '关闭统计后仍停留在工作台'
  ])
})

export const WORKBENCH_FIXTURE_DEPENDENCIES = Object.freeze({
  'WBF-004': Object.freeze({
    catalogNeedsProject: false,
    projectDependentEnhancements: ['日报非空、日报状态及跨用户日报数据权限反例'],
    independent: ['三类页签/门户路由', 'CRM 周/月专属草稿回读与展示']
  }),
  'WBF-005': Object.freeze({
    catalogNeedsProject: false,
    projectDependentEnhancements: [],
    independent: ['专属快捷偏好', '采购新增取号、表单关闭', '执行表弹窗及不保存订单']
  }),
  'WBF-008': Object.freeze({
    catalogNeedsProject: false,
    projectDependentEnhancements: ['日报已填及日报非零待审批提醒反例'],
    independent: ['三类提醒负例与 CRM 草稿正例', '用户偏好 UI 保存/DB 回读/刷新/隔离/还原']
  }),
  'WBF-009': Object.freeze({
    catalogNeedsProject: false,
    projectDependentEnhancements: [],
    independent: ['本轮专属角色命中门户', '精确区块显隐', '删除本轮门户后默认全部区块']
  }),
  'WBF-012': Object.freeze({
    catalogNeedsProject: false,
    projectDependentEnhancements: ['日报非空跨周期/状态统计'],
    independent: ['CRM 草稿非空本人跨周期统计', '统计入口/关闭'],
    nonProjectBlockers: ['CRM 团队查询固定本人', 'PMS 团队数据权限过滤未确认']
  })
})

export function recordCatalogAssertion (caseRecord, caseId, index, status, details) {
  const assertion = OWNED_CATALOG_ASSERTIONS[caseId]?.[index]
  if (!assertion || !['VERIFIED', 'FAILED', 'UNVERIFIED'].includes(status) || !details) {
    throw new Error('无效或无证据的工作台原断言登记')
  }
  caseRecord.catalogAssertions ||= []
  const existing = caseRecord.catalogAssertions.find((row) =>
    row.caseId === caseId && row.assertion === assertion)
  if (existing) throw new Error('工作台原断言重复登记')
  caseRecord.catalogAssertions.push({ caseId, assertion, status, details })
  if (status === 'FAILED') {
    caseRecord.checks.push({ name: assertion, passed: false, details })
  }
}

export function ownedCaseConclusion (caseId, caseRecord, gaps = []) {
  const assertions = OWNED_CATALOG_ASSERTIONS[caseId]
  if (!assertions) throw new Error('未定义工作台原断言')
  const rows = caseRecord.catalogAssertions || []
  const missing = assertions.filter((assertion) => !rows.some((row) =>
    row.caseId === caseId && row.assertion === assertion &&
    row.status === 'VERIFIED' && Boolean(row.details)))
  const failed = caseRecord.checks.some((row) => row.passed === false)
  const remaining = [...new Set([...gaps, ...missing.map((assertion) => `原断言未证实：${assertion}`)])]
  if (failed) remaining.push('本轮有失败断言，不能登记 PASS')
  caseRecord.remainingAssertions = remaining
  caseRecord.catalogComplete = missing.length === 0 && !failed
  return remaining.length
    ? { partial: true, catalogComplete: caseRecord.catalogComplete, note: remaining.join('；') }
    : { catalogComplete: true, note: '所有 catalog 原断言均有本轮证据；最终状态还需 runner 核对真实客户端错误' }
}
