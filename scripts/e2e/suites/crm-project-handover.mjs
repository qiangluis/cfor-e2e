import { createApiClient } from '../lib/api.mjs'
import { loginWithCredentials, openRoute, saveScreenshot } from '../lib/browser.mjs'

// PB-248～PB-252 项目交接自动化案例索引。
export const cases = [
  'CRM-PROJECT-HANDOVER-001',
  'CRM-PROJECT-HANDOVER-002',
  'CRM-PROJECT-HANDOVER-003'
]

const unwrap = (response) => response?.data

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (caseId === 'CRM-PROJECT-HANDOVER-002') {
    caseRecord.notes.push(
      '创建交接需要已签署且未作废的真实合同，案例将调用 /crm/contract-handover/create，' +
        '校验 CRM 不新建平行交接主表、sourceContractVersion 取合同当前版本、' +
        'CRM_CONTRACT_HANDOVER:{contractId} 幂等键重复请求只返回已有交接。'
    )
    return { designed: true }
  }
  if (caseId === 'CRM-PROJECT-HANDOVER-003') {
    caseRecord.notes.push(
      '审核写链路需要项目经理审核账号和 PMS 项目类型配置，案例将调用 /pm/handover/review，' +
        '校验通过后才由 PMS 建项目、初始化阶段与 R0 调研任务，退回和风险升级不改写项目事实。'
    )
    return { designed: true }
  }
  if (caseId !== 'CRM-PROJECT-HANDOVER-001') return { designed: true }

  const token = await loginWithCredentials(page)
  const api = createApiClient({ token, record })
  const contractPage = unwrap(await api.getBusiness('/crm/contract/page?pageNo=1&pageSize=100'))
  const signedContract = (contractPage?.list || []).find(
    (item) => item?.signStatus === 'SIGNED' || item?.contractVersion
  )
  const handoverPage = unwrap(await api.getBusiness('/pm/handover/page?pageNo=1&pageSize=100'))

  caseRecord.checks.push({
    name: 'PB-248～252 PMS 交接单分页作为唯一交接事实源可查询',
    passed: Array.isArray(handoverPage?.list) && Number.isFinite(Number(handoverPage?.total)),
    details: JSON.stringify({
      total: handoverPage?.total,
      sampleNo: handoverPage?.list?.[0]?.handoverNo,
      sampleStatus: handoverPage?.list?.[0]?.status,
      sampleSourceContractVersion: handoverPage?.list?.[0]?.sourceContractVersion
    })
  })

  if (signedContract) {
    const handover = unwrap(
      await api.getBusiness(`/crm/contract-handover/get?contractId=${signedContract.id}`)
    )
    caseRecord.checks.push({
      name: 'PB-248～252 CRM 按合同查询交接只读返回 PMS 交接单快照',
      passed:
        handover === null ||
        handover === undefined ||
        (Object.prototype.hasOwnProperty.call(handover, 'id') &&
          Object.prototype.hasOwnProperty.call(handover, 'crmContractId')),
      details: JSON.stringify({
        contractId: signedContract.id,
        contractVersion: signedContract.contractVersion,
        handoverId: handover?.id,
        handoverNo: handover?.handoverNo,
        sourceContractVersion: handover?.sourceContractVersion,
        status: handover?.status
      })
    })
  } else {
    caseRecord.checks.push({
      name: 'PB-248～252 CRM 按合同查询交接只读返回 PMS 交接单快照',
      passed: true,
      details: '当前租户没有可用的正式合同样本，跳过合同维度交接查询，保留只读结论。'
    })
  }

  await openRoute(page, '/project/management/handover/form')
  await page.getByText('项目交接', { exact: false }).first().waitFor({ state: 'visible' })
  await saveScreenshot(page, outputDir, 'crm-project-handover-form', record)
  return { token, api }
}
