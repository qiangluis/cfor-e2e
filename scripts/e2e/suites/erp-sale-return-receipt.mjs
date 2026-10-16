import { createApiClient } from '../lib/api.mjs'
import { loginWithCredentials, openRoute, saveScreenshot } from '../lib/browser.mjs'

// PB-274/275 销售退货申请、仓库实收和财务回写自动化案例索引。
export const cases = ['ERP-SALE-RETURN-RECEIPT-001', 'ERP-SALE-RETURN-RECEIPT-002']

const unwrap = (response) => response?.data

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (caseId === 'ERP-SALE-RETURN-RECEIPT-002') {
    caseRecord.notes.push(
      '部分收货闭环需要一条已完成审核、等待仓库审核的销售退货单，以及可安全审核的 302 入库单。' +
        '案例将校验实收数量取 settleQty/qty、BOM 子件按最小完整套数折算、差异和实收金额回写、' +
        '财务回写幂等，以及已财务回写后的仓库撤销和退货弃审阻断。'
    )
    return { designed: true }
  }
  if (caseId !== 'ERP-SALE-RETURN-RECEIPT-001') return { designed: true }

  const token = await loginWithCredentials(page)
  const api = createApiClient({ token, record })
  const pageResult = unwrap(await api.getBusiness('/erp/sale-return/page?pageNo=1&pageSize=100'))
  const sample = pageResult?.list?.[0]
  const sampleItem = sample?.items?.[0]

  caseRecord.checks.push({
    name: 'PB-274/275 销售退货分页返回收货和财务回写状态',
    passed:
      Array.isArray(pageResult?.list) &&
      Number.isFinite(Number(pageResult?.total)) &&
      (!sample ||
        (Object.prototype.hasOwnProperty.call(sample, 'receiptStatus') &&
          Object.prototype.hasOwnProperty.call(sample, 'receivedCount') &&
          Object.prototype.hasOwnProperty.call(sample, 'differenceCount') &&
          Object.prototype.hasOwnProperty.call(sample, 'receivedAmount') &&
          Object.prototype.hasOwnProperty.call(sample, 'financeWritebackStatus'))),
    details: JSON.stringify({
      total: pageResult?.total,
      sample: sample?.billNo,
      receiptStatus: sample?.receiptStatus,
      receivedCount: sample?.receivedCount,
      differenceCount: sample?.differenceCount,
      receivedAmount: sample?.receivedAmount,
      financeWritebackStatus: sample?.financeWritebackStatus
    })
  })

  caseRecord.checks.push({
    name: '销售退货明细返回实收、差异和实收金额字段',
    passed:
      !sampleItem ||
      (Object.prototype.hasOwnProperty.call(sampleItem, 'receivedCount') &&
        Object.prototype.hasOwnProperty.call(sampleItem, 'differenceCount') &&
        Object.prototype.hasOwnProperty.call(sampleItem, 'receivedTotalPrice')),
    details: JSON.stringify({
      sampleItem: sampleItem?.productName,
      receivedCount: sampleItem?.receivedCount,
      differenceCount: sampleItem?.differenceCount,
      receivedTotalPrice: sampleItem?.receivedTotalPrice
    })
  })

  await openRoute(page, '/erp/sale/return')
  await page.getByText('销售退货').first().waitFor({ state: 'visible' })
  if (sample) {
    await page.getByText(sample.billNo, { exact: false }).first().waitFor({ state: 'visible' })
  }
  await saveScreenshot(page, outputDir, 'erp-sale-return-receipt-list', record)
  return { token, api }
}
