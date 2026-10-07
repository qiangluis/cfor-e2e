import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { isStableId } from './base-partner.mjs'

export const cases = ['ERP-SETTLEMENT-001', 'ERP-SETTLEMENT-002']
export const settlementRuleRoute = '/settings/erp/settle-method-rule'
export const settlementRuleReadySelector = '.el-table__header-wrapper th:has-text("允许账户类型")'

export function validatePayableCheckReadonly(payload, caseRecord) {
  const page = assertBusinessSuccess(payload, '应付核销分页').data
  if (!page || !Array.isArray(page.records) || !Number.isSafeInteger(page.total) ||
      page.total < page.records.length || page.records.length > 100) {
    throw new Error('应付核销分页必须返回有效 data.records/total')
  }
  const rows = page.records
  const check = (name, passed, details) => {
    caseRecord.checks.push({ name, passed: Boolean(passed), details })
    if (!passed) throw new Error(`${name}：${details}`)
  }
  check('应付核销分页 records/total 结构有效', true, `rows=${rows.length}, total=${page.total}`)
  if (!rows.length) caseRecord.notes.push('前置缺失：没有核销单，自动/手工终审及编辑限制均未验证')
  else check('应付核销单返回稳定 ID、单据阶段及生效标记',
    rows.every((row) => isStableId(row?.id) && row.billStage != null &&
      [0, 1, '0', '1'].includes(row.isEffective)), `rows=${rows.length}`)
  const automatic = rows.filter((row) => [1, '1'].includes(row.isAuto))
  const manual = rows.filter((row) => [0, '0'].includes(row.isAuto))
  if (!automatic.length) caseRecord.notes.push('前置缺失：没有自动核销单，自动免审批终态未验证')
  else check('自动核销单终态为34且已生效',
    automatic.every((row) => String(row.billStage) === '34' && Number(row.isEffective) === 1),
    `automatic=${automatic.length}`)
  const terminalManual = manual.filter((row) => String(row.billStage) === '34')
  if (!terminalManual.length) caseRecord.notes.push('前置缺失：没有终审手工核销单，手工终态未验证')
  else check('终审手工核销单已生效',
    terminalManual.every((row) => Number(row.isEffective) === 1), `manualTerminal=${terminalManual.length}`)
  const terminal = rows.filter((row) => String(row.billStage) === '34')
  if (terminal.length) check('stage34 核销单不存在未生效记录',
    terminal.every((row) => Number(row.isEffective) === 1), `terminal=${terminal.length}`)
  caseRecord.notes.push('分页实体不提供 actions 编辑授权契约；未发送编辑反例，不能用缺失 actions 证明不可编辑')
  return { partial: true, note: '核销只读状态与页面已检查，自动/手工终审动作及编辑拒绝反例需专属夹具验证' }
}

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (caseId === 'ERP-SETTLEMENT-002') {
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
    return { token, api, ...readonlyResult }
  }

  const token = await login(page)
  const api = createApiClient({ token, record })
  const result = await api.get('/erp/settle-method-rule/page?pageNo=1&pageSize=100')
  const rows = Array.isArray(result?.data?.list) ? result.data.list : []
  caseRecord.checks.push({
    name: '结算方式规则分页返回字典编码和领域规则字段',
    passed:
      Array.isArray(result?.data?.list) &&
      rows.every((row) => row?.settleMethodCode && row?.direction && row?.version !== undefined),
    details: `rows=${rows.length}`
  })

  await openRoute(page, settlementRuleRoute, { readySelector: settlementRuleReadySelector })
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '结算方式规则设置页真实渲染',
    passed:
      new URL(page.url()).pathname === settlementRuleRoute &&
      bodyText.includes('结算方式') &&
      bodyText.includes('适用方向') &&
      bodyText.includes('允许账户类型'),
    details: page.url()
  })
  await saveScreenshot(page, outputDir, 'erp-settlement-method-rule', record)
  caseRecord.evidence.push('真实登录、规则分页契约和结算方式设置页截图')
  return { token, api }
}
