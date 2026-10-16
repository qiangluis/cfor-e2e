import { createApiClient } from '../lib/api.mjs'
import { loginWithCredentials, openRoute, saveScreenshot } from '../lib/browser.mjs'

// PB-237 合同变更自动化案例索引。
export const cases = ['CRM-CONTRACT-CHANGE-001', 'CRM-CONTRACT-CHANGE-002', 'CRM-CONTRACT-CHANGE-003']

const unwrap = (response) => response?.data

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (caseId === 'CRM-CONTRACT-CHANGE-002') {
    caseRecord.notes.push(
      '正式变更写链路需要一条已签署、未作废且审批通过的真实合同，案例将创建 /crm/contract-change 记录并提交审批，' +
        '校验基版本等于 crm_contract.contract_version、审批通过后才递增版本，且前端不再用 /crm/contract/update 冒充变更。'
    )
    return { designed: true }
  }
  if (caseId === 'CRM-CONTRACT-CHANGE-003') {
    caseRecord.notes.push(
      '口头诉求只写 ORAL_REQUEST 记录，不启动 BPM，也不修改正式合同版本；' +
        '已收款或已核销的付款节点金额、计划日期、节点名称和提醒天数在变更申请中不可修改。'
    )
    return { designed: true }
  }
  if (caseId !== 'CRM-CONTRACT-CHANGE-001') return { designed: true }

  const token = await loginWithCredentials(page)
  const api = createApiClient({ token, record })
  const changePage = unwrap(await api.getBusiness('/crm/contract-change/page?pageNo=1&pageSize=100'))
  const changeSample = changePage?.list?.[0]
  const contractPage = unwrap(await api.getBusiness('/crm/contract/page?pageNo=1&pageSize=100'))
  const contractSample = contractPage?.list?.[0]

  caseRecord.checks.push({
    name: 'PB-237 合同变更分页接口返回真实变更记录结构',
    passed:
      Array.isArray(changePage?.list) &&
      Number.isFinite(Number(changePage?.total)) &&
      (!changeSample ||
        (Object.prototype.hasOwnProperty.call(changeSample, 'contractId') &&
          Object.prototype.hasOwnProperty.call(changeSample, 'requestType') &&
          Object.prototype.hasOwnProperty.call(changeSample, 'status'))),
    details: JSON.stringify({
      total: changePage?.total,
      sampleId: changeSample?.id,
      contractId: changeSample?.contractId,
      requestType: changeSample?.requestType,
      status: changeSample?.status,
      baseContractVersion: changeSample?.baseContractVersion
    })
  })

  caseRecord.checks.push({
    name: 'PB-237 正式合同暴露 contractVersion 版本字段供变更基版本校验',
    passed: !contractSample || Object.prototype.hasOwnProperty.call(contractSample, 'contractVersion'),
    details: JSON.stringify({
      total: contractPage?.total,
      sampleNo: contractSample?.no,
      contractVersion: contractSample?.contractVersion,
      signStatus: contractSample?.signStatus
    })
  })

  await openRoute(page, '/crm/jixu/contract')
  await page.getByText('合同', { exact: false }).first().waitFor({ state: 'visible' })
  if (contractSample?.no) {
    await page.getByText(contractSample.no, { exact: false }).first().waitFor({ state: 'visible' })
  }
  await saveScreenshot(page, outputDir, 'crm-contract-change-list', record)
  return { token, api }
}
