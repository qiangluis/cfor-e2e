import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['ERP-SETTLEMENT-001', 'ERP-SETTLEMENT-002']

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (caseId === 'ERP-SETTLEMENT-002') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const checkPage = await api.getBusiness('/finance/finPayableCheck/list?pageNo=1&pageSize=100')
    const checkRows = Array.isArray(checkPage?.data?.records) ? checkPage.data.records : []
    caseRecord.checks.push({
      name: '应付核销单列表返回单据阶段与生效标记',
      passed:
        Array.isArray(checkPage?.data?.records) &&
        checkRows.every(
          (row) =>
            row?.id &&
            Object.prototype.hasOwnProperty.call(row, 'billStage') &&
            Object.prototype.hasOwnProperty.call(row, 'isEffective')
        ),
      details: `rows=${checkRows.length}`
    })
    const autoRows = checkRows.filter((row) => Number(row?.isAuto) === 1)
    caseRecord.checks.push({
      name: '自动核销单免人工审批，直接落在核批完+执行完(34)且已生效',
      passed: autoRows.every(
        (row) => String(row?.billStage) === '34' && Number(row?.isEffective) === 1
      ),
      details: `autoRows=${autoRows.length}`
    })
    caseRecord.checks.push({
      name: '不存在停留在核批中(22)的自动核销单，也不存在 stage=34 但未生效的僵尸单据',
      passed:
        autoRows.every((row) => String(row?.billStage) !== '22') &&
        checkRows
          .filter((row) => String(row?.billStage) === '34')
          .every((row) => Number(row?.isEffective) === 1),
      details: `stage22Auto=${autoRows.filter((row) => String(row?.billStage) === '22').length}`
    })
    const effectiveRows = checkRows.filter((row) => Number(row?.isEffective) === 1)
    caseRecord.checks.push({
      name: '已终审核销单不可直接编辑，只保留查询与受控修正入口',
      passed: effectiveRows.every((row) => row?.actions?.edit !== true),
      details: `effectiveRows=${effectiveRows.length}`
    })

    await openRoute(page, '/finance/payableManage/payWriteOff')
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
    return { token, api }
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

  await openRoute(page, '/erp/settings/settle-method-rule')
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '结算方式规则设置页真实渲染',
    passed:
      page.url().includes('/erp/settings/settle-method-rule') &&
      bodyText.includes('结算方式') &&
      bodyText.includes('适用方向') &&
      bodyText.includes('允许账户类型'),
    details: page.url()
  })
  await saveScreenshot(page, outputDir, 'erp-settlement-method-rule', record)
  caseRecord.evidence.push('真实登录、规则分页契约和结算方式设置页截图')
  return { token, api }
}
