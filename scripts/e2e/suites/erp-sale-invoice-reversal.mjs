import { createApiClient } from '../lib/api.mjs'
import { loginWithCredentials, openRoute, saveScreenshot } from '../lib/browser.mjs'

// PB-273 销售发票红冲、作废与审计字段自动化案例索引。
export const cases = ['ERP-SALE-INVOICE-REVERSAL-001', 'ERP-SALE-INVOICE-REVERSAL-002']

const unwrap = (response) => response?.data

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (caseId === 'ERP-SALE-INVOICE-REVERSAL-002') {
    caseRecord.notes.push(
      '完整红冲闭环需要一条已生效、未作废、未红冲的蓝字销售发票。' +
        '案例将校验红冲类型和原因必填、红字金额/明细取反、原票关联、重复红冲阻断，' +
        '并通过状态条件更新确认已生效发票不能直接修改、删除或作废。'
    )
    return { designed: true }
  }
  if (caseId !== 'ERP-SALE-INVOICE-REVERSAL-001') return { designed: true }

  const token = await loginWithCredentials(page)
  const api = createApiClient({ token, record })
  const pageResult = unwrap(await api.getBusiness('/erp/sale-invoice/page?pageNo=1&pageSize=100'))
  const sample = pageResult?.list?.[0]
  caseRecord.checks.push({
    name: 'PB-273 销售发票分页返回红冲、作废与状态字段',
    passed:
      Array.isArray(pageResult?.list) &&
      Number.isFinite(Number(pageResult?.total)) &&
      (!sample ||
        (Object.prototype.hasOwnProperty.call(sample, 'isRubric') &&
          Object.prototype.hasOwnProperty.call(sample, 'isEffective') &&
          Object.prototype.hasOwnProperty.call(sample, 'isVoided'))),
    details: JSON.stringify({
      total: pageResult?.total,
      sample: sample?.billNo,
      isRubric: sample?.isRubric,
      isEffective: sample?.isEffective,
      isVoided: sample?.isVoided
    })
  })

  await openRoute(page, '/erp/sale/invoice')
  await page.getByText('销售发票').first().waitFor({ state: 'visible' })
  if (sample) {
    await page.getByText(sample.billNo, { exact: false }).first().waitFor({ state: 'visible' })
  }
  await saveScreenshot(page, outputDir, 'erp-sale-invoice-reversal-list', record)
  return { token, api }
}
