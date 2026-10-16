import { createApiClient } from '../lib/api.mjs'
import { loginWithCredentials, openRoute, saveScreenshot } from '../lib/browser.mjs'

// PB-238 合同结果分流（售后资产服务期衔接）自动化案例索引。
export const cases = ['CRM-CONTRACT-SERVICE-PERIOD-001', 'CRM-CONTRACT-SERVICE-PERIOD-002']

const unwrap = (response) => response?.data
/** CrmContractSignStatusEnum.SIGNED */
const SIGNED = 30

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (caseId === 'CRM-CONTRACT-SERVICE-PERIOD-002') {
    caseRecord.notes.push(
      '写链路需要一条已签署的续费/运维服务合同，且该客户已有售后资产：' +
        '/crm/contract-service-period/append 只接受归属该合同客户的资产，' +
        '以 CRM_CONTRACT_SERVICE:{contractId}:{assetId} 幂等写入售后 after_sales_asset_service_period；' +
        '客户没有售后资产时按建议走项目交接，不在此接口凭空建档。'
    )
    return { designed: true }
  }
  if (caseId !== 'CRM-CONTRACT-SERVICE-PERIOD-001') return { designed: true }

  const token = await loginWithCredentials(page)
  const api = createApiClient({ token, record })
  const contractPage = unwrap(await api.getBusiness('/crm/contract/page?pageNo=1&pageSize=100'))
  const contracts = Array.isArray(contractPage?.list) ? contractPage.list : []
  const signed = contracts.find((item) => Number(item?.signStatus) === SIGNED)

  caseRecord.checks.push({
    name: 'PB-238 合同台账分页可读且返回签署状态字段',
    passed:
      Array.isArray(contractPage?.list) &&
      Number.isFinite(Number(contractPage?.total)) &&
      (contracts.length === 0 ||
        Object.prototype.hasOwnProperty.call(contracts[0], 'signStatus')),
    details: JSON.stringify({
      total: contractPage?.total,
      signedContracts: contracts.filter((item) => Number(item?.signStatus) === SIGNED).length
    })
  })

  if (signed?.id) {
    const preview = unwrap(
      await api.getBusiness(`/crm/contract-service-period/preview?contractId=${signed.id}`)
    )
    caseRecord.checks.push({
      name: 'PB-238 预览接口按合同返回建议动作与待承接售后资产',
      passed:
        Number(preview?.contractId) === Number(signed.id) &&
        ['SERVICE_PERIOD_EXTEND', 'PROJECT_HANDOVER'].includes(preview?.recommendedAction) &&
        Array.isArray(preview?.assets) &&
        Boolean(preview?.proposedStartDate) &&
        Boolean(preview?.proposedEndDate),
      details: JSON.stringify({
        contractNo: preview?.contractNo,
        recommendedAction: preview?.recommendedAction,
        assetCount: preview?.assets?.length,
        proposedStartDate: preview?.proposedStartDate,
        proposedEndDate: preview?.proposedEndDate
      })
    })
    caseRecord.checks.push({
      name: 'PB-238 建议动作与客户售后资产事实一致',
      passed:
        preview?.assets?.length > 0
          ? preview?.recommendedAction === 'SERVICE_PERIOD_EXTEND'
          : preview?.recommendedAction === 'PROJECT_HANDOVER',
      details: `assets=${preview?.assets?.length ?? 0}, action=${preview?.recommendedAction}`
    })
  } else {
    caseRecord.notes.push(
      '当前租户没有已签署合同，跳过 /crm/contract-service-period/preview 实测；' +
        '案例保持只读，不造合同数据，合同服务期写链路见 -002。'
    )
  }

  await openRoute(page, '/crm/jixu/contract', { readyText: '合同' })
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: 'PB-238 合同台账页面渲染成功期承接入口所在工作台',
    passed: page.url().includes('/crm/jixu/contract') && bodyText.includes('合同'),
    details: page.url()
  })
  await saveScreenshot(page, outputDir, 'crm-contract-service-period-list', record)
  caseRecord.evidence.push('真实登录、CRM 合同分页与服务期承接预览接口校验、合同台账页面截图')

  return { token, api }
}
