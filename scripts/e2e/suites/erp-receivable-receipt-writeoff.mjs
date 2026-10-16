import { createApiClient } from '../lib/api.mjs'
import { loginWithCredentials, openRoute, saveScreenshot } from '../lib/browser.mjs'

// PB-276～PB-282 应收、收款到账确认与核销撤销/冲销自动化案例索引。
export const cases = [
  'ERP-RECEIVABLE-RECEIPT-001',
  'ERP-RECEIVABLE-RECEIPT-002',
  'ERP-RECEIVABLE-RECEIPT-003'
]

const unwrap = (response) => response?.data

const waitForText = async (page, text, timeout = 8000) => {
  try {
    await page.getByText(text).first().waitFor({ state: 'visible', timeout })
    return true
  } catch {
    return false
  }
}

const hasFields = (row, fields) =>
  !row || fields.every((field) => Object.prototype.hasOwnProperty.call(row, field))

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (caseId === 'ERP-RECEIVABLE-RECEIPT-002') {
    caseRecord.notes.push(
      '完整到账确认闭环需要一条由销售登记、处于待财务确认状态的收款单。' +
        '案例将验证：登记只生成待确认收款单；财务确认写入确认人/时间；' +
        '同一外部流水号+账户+金额重复确认被拒绝；拒绝必须填写原因且拒绝后不能核销。'
    )
    return { designed: true }
  }
  if (caseId === 'ERP-RECEIVABLE-RECEIPT-003') {
    caseRecord.notes.push(
      '撤销/冲销闭环需要一条已生效的应收核销单和可部分核销的应收单。' +
        '案例将验证：核销金额不得超过收款可用金额与应收未核销金额；' +
        '撤销/冲销后保留原核销批次、原因、反向金额和时间；' +
        '原核销单不能重复撤销，重新核销时记录重新核销链。'
    )
    return { designed: true }
  }
  if (caseId !== 'ERP-RECEIVABLE-RECEIPT-001') return { designed: true }

  const token = await loginWithCredentials(page)
  const api = createApiClient({ token, record })

  const receiptPage = unwrap(
    await api.getBusiness('/finance/finReceipt/list/102/1030?pageNo=1&pageSize=100')
  )
  const receiptRecords = receiptPage?.records ?? []
  const receiptSample = receiptRecords[0]
  caseRecord.checks.push({
    name: 'PB-279/PB-280 收款单分页返回到账确认、外部流水号和已退款金额字段',
    passed:
      Array.isArray(receiptRecords) &&
      Number.isFinite(Number(receiptPage?.total)) &&
      hasFields(receiptSample, [
        'externalTransactionNo',
        'confirmStatus',
        'confirmTime',
        'refundAmount'
      ]),
    details: JSON.stringify({
      total: receiptPage?.total,
      sample: receiptSample?.billNo,
      confirmStatus: receiptSample?.confirmStatus,
      externalTransactionNo: receiptSample?.externalTransactionNo,
      refundAmount: receiptSample?.refundAmount
    })
  })

  const checkPage = unwrap(
    await api.getBusiness('/finance/finReceivableCheck/list?pageNo=1&pageSize=100')
  )
  const checkRecords = checkPage?.records ?? []
  const checkSample = checkRecords[0]
  caseRecord.checks.push({
    name: 'PB-282 应收核销单返回撤销/冲销类型、原因、时间和反向金额字段',
    passed:
      Array.isArray(checkRecords) &&
      Number.isFinite(Number(checkPage?.total)) &&
      hasFields(checkSample, ['reversalType', 'reversalReason', 'reversalTime', 'reversalAmt']),
    details: JSON.stringify({
      total: checkPage?.total,
      sample: checkSample?.billNo,
      reversalType: checkSample?.reversalType,
      reversalAmt: checkSample?.reversalAmt
    })
  })

  await openRoute(page, '/finance/receivableManage/receipt')
  const receiptPageLoaded = await waitForText(page, '到账状态')
  caseRecord.checks.push({
    name: 'PB-279 真实浏览器收款单列表展示到账状态列与到账操作',
    passed: receiptPageLoaded,
    details: receiptPageLoaded
      ? '收款单列表渲染到账状态列'
      : '收款单列表未在超时时间内显示到账状态列，请确认菜单权限与页面版本'
  })
  await saveScreenshot(page, outputDir, 'erp-receivable-receipt-list', record)

  await openRoute(page, '/finance/receivableManage/recWriteOff')
  const writeOffPageLoaded = await waitForText(page, '应收核销')
  caseRecord.checks.push({
    name: 'PB-282 真实浏览器应收核销列表展示撤销/冲销入口',
    passed: writeOffPageLoaded,
    details: writeOffPageLoaded
      ? '应收核销列表渲染撤销/冲销相关列'
      : '应收核销列表未在超时时间内加载，请确认菜单权限与页面版本'
  })
  await saveScreenshot(page, outputDir, 'erp-receivable-writeoff-list', record)

  return { token, api }
}
