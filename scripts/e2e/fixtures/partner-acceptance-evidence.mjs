import fs from 'node:fs'

const roleFields = ['customerEnabled', 'supplierEnabled', 'carrierEnabled']
const roleFilterChecks = roleFields.flatMap((field) => [
  `${field} 分页过滤仅返回同一专属客商`,
  ...roleFields.map((filter) => `${field} 单角色在 ${filter} 筛选中的包含/排除正确`)
])
const mappings = [
  ['客商档案页面按真实菜单完整路由渲染', 'PB034 双租户客商真实页面唯一正控制展示完整'],
  ['同一客商可同时启用客户、供应商和承运商角色',
    ...roleFields.map((field) => `专属客商切换为 ${field} 单角色后回读开关`)],
  roleFilterChecks,
  ['创建后回读稳定 ID、双角色与自动生成的角色编码',
    '稳定客商编码创建后不可修改', 'PB034 双租户客商真实页面唯一正控制展示完整'],
  ['统一客商分页来自 base_partner 单表', '旧客户接口写入落到 base_partner（统一客商可见）',
    '旧客户分页经只读兼容视图读取统一客商'],
  ['CRM 创建客户正式回读并通过 partner_id 关联唯一 base_partner 客户角色',
    '旧 ERP 客户主档为只读兼容视图，CRM 客户投影使用同一统一客商编号']
]
const gapChecks = [
  'PB034 双租户实际菜单页面刷新回读专属客商',
  'PB034 双租户客商真实页面唯一正控制展示完整',
  'PB034 隔离业务正式清理账号套餐租户停用且令牌zero',
  'CRM 专属验收账号正式退出并停用，不改共享账号或客户配额'
]

export const recordPartnerCatalogEvidence = (caseRecord, definition) => {
  const original = definition || JSON.parse(fs.readFileSync(
    new URL('../cases/catalog.json', import.meta.url), 'utf8'
  )).suites.flatMap((suite) => suite.cases).find((item) => item.id === 'PB034-002')
  if (original?.id !== 'PB034-002' || original.assertions?.length !== mappings.length ||
      original.acceptanceGaps?.length !== 1) {
    throw new Error('PB034 original assertion shape changed; re-audit the evidence mapping')
  }
  const map = (assertion, index, names) => {
    const sources = names.map((name) => caseRecord.checks.filter((check) => check.name === name))
    const verified = names.length > 0 && sources.every((matches) =>
      matches.length === 1 && matches[0].passed === true)
    return {
      index, assertion, status: verified ? 'VERIFIED' : 'GAP',
      evidenceChecks: [...names],
      details: sources.map((matches, position) => matches.length === 1
        ? `${names[position]}: ${matches[0].details || ''}`
        : `Missing unique evidence: ${names[position]}`).join('; ')
    }
  }
  caseRecord.catalogAssertions = original.assertions.map((assertion, index) =>
    map(assertion, index, mappings[index]))
  const gap = map(original.acceptanceGaps[0], mappings.length, gapChecks)
  caseRecord.catalogAssertions.push(gap)
  caseRecord.acceptanceGapAssertions = [gap]
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((row) => row.status !== 'VERIFIED').map((row) => row.assertion)
  caseRecord.catalogComplete = caseRecord.remainingAssertions.length === 0
  caseRecord.passCandidate = caseRecord.catalogComplete &&
    caseRecord.checks.every((check) => check.passed === true)
  if (gap.status === 'VERIFIED') {
    caseRecord.notes = caseRecord.notes.filter((note) => note !== `GAP: ${gap.assertion}`)
  }
  return caseRecord.passCandidate
}
