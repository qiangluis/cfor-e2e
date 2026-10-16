import fs from 'node:fs'
import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { config } from '../config/index.mjs'
import { assertLocalWriteSafety, databaseConfigured } from '../lib/db.mjs'
import { createSettleRuleWriteFixture } from '../fixtures/procurement-settle-rule-write.mjs'

export const cases = ['ERP-SETTLEMENT-001', 'ERP-SETTLEMENT-002']
export const settlementRuleRoute = '/settings/erp/settle-method-rule'
export const settlementRuleReadySelector = '.el-table__header-wrapper th:has-text("允许账户类型")'

const rowOf = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const boolish = (value) => value === true || value === false || [0, 1, '0', '1'].includes(value)

/**
 * Map real execution against the frozen original catalog so acceptanceComplete
 * can only become true when every original assertion has structured VERIFIED
 * evidence. The catalog file itself is never rewritten.
 */
export function settlementCatalogEvidence (caseId, caseRecord, evidence = {}) {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const definition = catalog.suites.flatMap((suite) => suite.cases).find((item) => item.id === caseId)
  if (!definition) throw new Error(`缺少原 catalog 案例 ${caseId}`)
  caseRecord.catalogAssertions = (definition.assertions || []).map((assertion, index) => {
    const item = evidence[index] || {}
    const names = Array.isArray(item) ? item : item.checks || []
    const checks = names.map((name) => caseRecord.checks.find((check) => check.name === name))
    const verified = names.length > 0 && checks.every((check) => check?.passed === true)
    return {
      index,
      assertion,
      status: verified ? 'VERIFIED' : 'GAP',
      evidenceChecks: names,
      details: item.details || (verified
        ? checks.map((check) => `${check.name}: ${check.details || ''}`).join('; ')
        : (item.gap || '本轮未形成完整证据'))
    }
  })
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((item) => item.status === 'GAP').map((item) => item.assertion)
  caseRecord.passCandidate = caseRecord.remainingAssertions.length === 0 &&
    caseRecord.checks.length > 0 && caseRecord.checks.every((check) => check.passed !== false)
  caseRecord.notes.push(
    `原 catalog 未修改；PASS候选=${caseRecord.passCandidate}；` +
    `剩余=${caseRecord.remainingAssertions.join('；') || '无'}`
  )
  return caseRecord
}

/**
 * ERP-SETTLEMENT-002 readonly scan. Only throws on a structurally invalid
 * payload; missing terminal/auto/manual samples are reported as precise GAPs so
 * the case never claims a pass from an empty set.
 */
export function validatePayableCheckReadonly (payload, caseRecord) {
  const page = assertBusinessSuccess(payload, '应付核销分页').data
  if (!page || !Array.isArray(page.records) || !Number.isSafeInteger(page.total) ||
      page.total < page.records.length || page.records.length > 100) {
    throw new Error('应付核销分页必须返回有效 data.records/total')
  }
  const rows = page.records
  const check = (name, passed, details) => {
    caseRecord.checks.push({ name, passed: Boolean(passed), details })
    return Boolean(passed)
  }
  check('应付核销分页 records/total 结构有效', true, `rows=${rows.length}, total=${page.total}`)

  const stageRows = rows.filter((row) => rowOf(row) && row.billStage != null && boolish(row.isEffective))
  if (rows.length === 0) {
    caseRecord.notes.push('前置缺失：没有核销单样本，单据阶段与生效标记无实例可核验')
  } else {
    check('核销单列表返回单据阶段与生效标记',
      stageRows.length === rows.length, `rows=${rows.length}, total=${page.total}`)
  }

  const automatic = rows.filter((row) => [1, '1'].includes(row.isAuto))
  const manual = rows.filter((row) => [0, '0'].includes(row.isAuto))
  const autoTerminal = automatic.filter((row) => String(row.billStage) === '34' &&
    Number(row.isEffective) === 1)
  const manualTerminal = manual.filter((row) => String(row.billStage) === '34' &&
    Number(row.isEffective) === 1)
  if (!automatic.length) caseRecord.notes.push('前置缺失：没有自动核销单样本，免审批终态未验证')
  if (!manual.length) caseRecord.notes.push('前置缺失：没有手工核销单样本，免审批终态未验证')
  if (automatic.length && manual.length) {
    check('自动与手工核销单终态为核批完24/执行完34且已生效，免停留核批中',
      autoTerminal.length === automatic.length && manualTerminal.length > 0 &&
        automatic.every((row) => [24, 34, '24', '34'].includes(row.billStage)),
      `automatic=${automatic.length}, autoTerminal=${autoTerminal.length}, ` +
        `manual=${manual.length}, manualTerminal=${manualTerminal.length}`)
  }

  if (rows.length > 0) {
    const stage34 = rows.filter((row) => String(row.billStage) === '34')
    const zombie = stage34.filter((row) => Number(row.isEffective) !== 1)
    const autoStuck = automatic.filter((row) => String(row.billStage) === '22')
    check('不存在停在核批中22的自动核销单，也不存在stage34未生效僵尸单',
      autoStuck.length === 0 && zombie.length === 0,
      `autoStuck=${autoStuck.length}, zombie=${zombie.length}, stage34=${stage34.length}`)
  }

  const miss = []
  if (rows.length === 0) miss.push('无核销单样本')
  if (!automatic.length || !manual.length) miss.push('自动/手工终态样本不足')
  const partial = miss.length > 0
  const note = partial
    ? `核销只读结构与页面已检查，但${miss.join('；')}`
    : undefined
  return { partial, note }
}

async function runSettlementRuleCase ({ page, record, caseRecord, outputDir }) {
  const token = await login(page)
  const api = createApiClient({ token, record })

  const rulePage = await api.getBusiness('/erp/settle-method-rule/page?pageNo=1&pageSize=100')
  const rows = Array.isArray(rulePage?.data?.list) ? rulePage.data.list : []
  const dictPage = await api.getBusiness(
    '/system/dict-data/page?pageNo=1&pageSize=100&dictType=x_settle_method')
  const dictRows = Array.isArray(dictPage?.data?.list) ? dictPage.data.list : []
  const dictByValue = new Map(dictRows.map((row) => [String(row.value), row]))
  const dictBacked = rows.length > 0 && rows.every((row) =>
    row?.settleMethodCode && row?.settleMethodName &&
    dictByValue.has(String(row.settleMethodCode)) &&
    String(dictByValue.get(String(row.settleMethodCode))?.label) === String(row.settleMethodName))
  caseRecord.checks.push({
    name: '结算方式编码和名称来自 x_settle_method 字典目录',
    passed: dictBacked,
    details: `rules=${rows.length}, dictRows=${dictRows.length}`
  })

  const rulesComplete = Array.isArray(rulePage?.data?.list) && rows.length > 0 && rows.every((row) =>
    typeof row?.direction === 'string' && row.direction.length > 0 &&
    row?.allowedAccountTypes !== undefined &&
    row?.requireBillNo !== undefined && row?.requireDueDate !== undefined &&
    row?.version !== undefined)
  caseRecord.checks.push({
    name: 'ERP 结算规则返回收付款方向、账户类型、票据要求与版本',
    passed: rulesComplete,
    details: `rows=${rows.length}`
  })
  if (!rows.length) caseRecord.notes.push('前置缺失：没有结算方式规则样本，字典来源与领域字段未验证')

  await openRoute(page, settlementRuleRoute, { readySelector: settlementRuleReadySelector })
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '结算方式规则设置页真实渲染业务表头',
    passed:
      new URL(page.url()).pathname === settlementRuleRoute &&
      bodyText.includes('结算方式') &&
      bodyText.includes('适用方向') &&
      bodyText.includes('允许账户类型'),
    details: page.url()
  })
  await saveScreenshot(page, outputDir, 'erp-settlement-method-rule', record)

  const env = process.env
  const writeEnabled = env.CFOR_E2E_WRITE_FIXTURES === 'true'
  if (!writeEnabled) {
    settlementCatalogEvidence('ERP-SETTLEMENT-001', caseRecord, {
      0: ['结算方式编码和名称来自 x_settle_method 字典目录'],
      1: ['ERP 结算规则返回收付款方向、账户类型、票据要求与版本'],
      2: { gap: '未开启 CFOR_E2E_WRITE_FIXTURES，订单结算方式与规则版本快照未执行写侧' }
    })
    caseRecord.evidence.push('真实登录、结算方式规则分页、x_settle_method 字典交叉核对与设置页截图')
    return { token, api, partial: true, note: '结算方式目录与规则字段只读已核对，订单快照写侧未执行' }
  }
  if (config.target !== 'local') {
    throw new Error('BLOCKED: ERP-SETTLEMENT-001 写侧验收仅允许本地 local target')
  }
  if (!databaseConfigured()) {
    throw new Error('BLOCKED: ERP-SETTLEMENT-001 写侧验收需要配置本地数据库只读证据，尚未创建规则')
  }
  await assertLocalWriteSafety(caseRecord)
  let write
  try {
    write = await createSettleRuleWriteFixture(api, caseRecord)
  } catch (error) {
    const fixture = caseRecord.fixtures?.find((item) => item.kind === 'procurement-settle-rule-write')
    if (fixture?.status === 'creating') {
      fixture.status = 'failed'
      fixture.failure = String(error.message || error).slice(0, 500)
      caseRecord.evidence.push(`ERP-SETTLEMENT-001 专属夹具中途失败，已登记 retained IDs；${fixture.failure}`)
    }
    throw error
  }
  write.fixture.status = 'verified'
  write.fixture.cleanup = {
    rule: 'disabled',
    retainedOrderIds: [write.orderV1?.orderId, write.orderV2?.orderId].filter(Boolean)
  }
  caseRecord.checks.push({
    name: '专属结算方式字典与规则编码名称一致且版本1回读',
    passed:
      Boolean(write.dictionaryId) &&
      write.createdRule?.settleMethodCode === write.code &&
      write.createdRule?.settleMethodName === `E2E结算规则-${write.tag}` &&
      Number(write.createdRule?.version) === 1,
    details: `ruleId=${write.ruleId}, code=${write.code}, version=${write.createdRule?.version}`
  })
  caseRecord.checks.push({
    name: '专属规则返回方向/账户类型/票据要求/账期与递增版本',
    passed:
      write.createdRule?.direction === 'BOTH' &&
      write.createdRule?.allowedAccountTypes === null &&
      write.createdRule?.requireBillNo === false &&
      write.createdRule?.requireDueDate === false &&
      write.createdRule?.allowCredit === true &&
      Number(write.createdRule?.defaultCreditDays) === 30 &&
      Number(write.ruleV2?.version) === 2,
    details: `direction=${write.createdRule?.direction}, version=${write.ruleV2?.version}`
  })
  caseRecord.checks.push({
    name: '订单保存结算方式编码与规则版本快照且历史不回溯',
    passed:
      write.orderV1?.detail?.settleMethodCode === write.code &&
      Number(write.orderV1?.detail?.settleMethodRuleVersion) === 1 &&
      write.orderV2?.detail?.settleMethodCode === write.code &&
      Number(write.orderV2?.detail?.settleMethodRuleVersion) === 2 &&
      Number(write.orderV1After?.settleMethodRuleVersion) === 1,
    details: `orderV1=${write.orderV1?.orderId}(v${write.orderV1?.detail?.settleMethodRuleVersion}), ` +
      `orderV2=${write.orderV2?.orderId}(v${write.orderV2?.detail?.settleMethodRuleVersion}), ` +
      `orderV1After=v${write.orderV1After?.settleMethodRuleVersion}`
  })
  await saveScreenshot(page, outputDir, 'erp-settlement-method-rule-write-side', record)
  caseRecord.evidence.push(
    `专属结算方式 ${write.code}、规则 ${write.ruleId} 创建/更新版本1→2/停用、` +
    `采购订单 ${write.orderV1?.orderId}/${write.orderV2?.orderId} 结算方式与版本快照`
  )
  settlementCatalogEvidence('ERP-SETTLEMENT-001', caseRecord, {
    0: ['专属结算方式字典与规则编码名称一致且版本1回读'],
    1: ['专属规则返回方向/账户类型/票据要求/账期与递增版本'],
    2: ['订单保存结算方式编码与规则版本快照且历史不回溯']
  })
  return { token, api }
}

async function runPayableCheckCase ({ page, record, caseRecord, outputDir }) {
  const token = await login(page)
  const api = createApiClient({ token, record })
  const checkPage = await api.getBusiness('/finance/finPayableCheck/list?pageNo=1&pageSize=100')
  const readonlyResult = validatePayableCheckReadonly(checkPage, caseRecord)

  await openRoute(page, '/finance/payableManage/payWriteOff', {
    readySelector: '.vxe-header--column:has-text("核销金额")'
  })
  await page.waitForFunction(
    () =>
      document.body.innerText.includes('单据阶段') &&
      document.body.innerText.includes('核销金额'),
    { timeout: 60000 }
  )
  const checkBodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '应付核销单页面真实渲染单据阶段与核销金额列',
    passed:
      page.url().includes('/finance/payableManage/payWriteOff') &&
      checkBodyText.includes('单据阶段') &&
      checkBodyText.includes('核销金额'),
    details: page.url()
  })
  await saveScreenshot(page, outputDir, 'erp-payable-check-auto-audit', record)
  caseRecord.evidence.push('真实登录、应付核销单阶段契约检查和核销单页面截图')

  settlementCatalogEvidence('ERP-SETTLEMENT-002', caseRecord, {
    0: ['核销单列表返回单据阶段与生效标记'],
    1: ['自动与手工核销单终态为核批完24/执行完34且已生效，免停留核批中'],
    2: ['不存在停在核批中22的自动核销单，也不存在stage34未生效僵尸单'],
    3: ['应付核销单页面真实渲染单据阶段与核销金额列']
  })
  return { token, api, ...readonlyResult }
}

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (caseId === 'ERP-SETTLEMENT-002') {
    return runPayableCheckCase({ page, record, caseRecord, outputDir })
  }
  return runSettlementRuleCase({ page, record, caseRecord, outputDir })
}
