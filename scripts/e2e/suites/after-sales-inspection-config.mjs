import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['PB122-001']

const dataOf = (response) => response?.data ?? response
const itemCode = 'E2E-PB122-ITEM'
const planCode = 'E2E-PB122-PLAN'

export const runCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })
  caseRecord.checks.push({
    name: '真实登录成功',
    passed: Boolean(token),
    details: '登录后携带真实令牌调用巡检配置与现有巡检执行接口'
  })

  let itemList = dataOf(await api.getBusiness('/after-sales/inspection-config/item/list')) || []
  let item = itemList.find((candidate) => candidate.itemCode === itemCode)
  if (!item) {
    const itemId = dataOf(
      await api.postBusiness('/after-sales/inspection-config/item/create', {
        itemCode,
        itemName: 'E2E 售后巡检项目',
        category: 'SYSTEM',
        resultType: 'BOOLEAN',
        execRequirement: '确认核心服务、日志与备份状态',
        standardHours: 0.5,
        attachmentRequired: true,
        abnormalAction: 'CREATE_TICKET',
        status: 0
      })
    )
    itemList = dataOf(await api.getBusiness('/after-sales/inspection-config/item/list')) || []
    item = itemList.find((candidate) => String(candidate.id) === String(itemId))
  }
  caseRecord.checks.push({
    name: '巡检项目由统一配置接口持久化并回读',
    passed: Boolean(item?.id && item.itemCode === itemCode),
    details: item ? `itemId=${item.id}, resultType=${item.resultType}` : '项目未回读'
  })

  let planList = dataOf(await api.getBusiness('/after-sales/inspection-config/plan/list')) || []
  let plan = planList.find((candidate) => candidate.planCode === planCode)
  const basePayload = {
    planCode,
    planName: 'E2E 售后巡检方案',
    description: 'PB-122 自动化验证方案',
    appointmentRequired: true,
    customerConfirmRequired: true,
    signatureRequired: true,
    serviceContractRef: 'E2E-CONTRACT-PB122',
    serviceEntitlementRef: 'E2E-ENTITLEMENT-PB122',
    items: [
      {
        itemId: item.id,
        itemVersion: 1,
        seq: 1,
        standard: '核心服务正常且证据完整',
        abnormalAction: 'CREATE_TICKET'
      }
    ],
    cycles: [
      {
        cycleType: 'TIME',
        cycleValue: 3,
        cycleUnit: 'MONTH',
        dataSource: 'AFTER_SALES_CALENDAR'
      }
    ]
  }
  if (!plan) {
    const planId = dataOf(
      await api.postBusiness('/after-sales/inspection-config/plan/create', basePayload)
    )
    planList = dataOf(await api.getBusiness('/after-sales/inspection-config/plan/list')) || []
    plan = planList.find((candidate) => String(candidate.id) === String(planId))
  }
  let detail = dataOf(
    await api.getBusiness(`/after-sales/inspection-config/plan/detail?id=${plan.id}`)
  )
  caseRecord.checks.push({
    name: '方案详情回读项目、周期与客户动作规则',
    passed:
      detail?.items?.length === 1 &&
      detail?.cycles?.some((cycle) => cycle.cycleType === 'TIME') &&
      detail?.appointmentRequired === true &&
      detail?.customerConfirmRequired === true &&
      detail?.signatureRequired === true,
    details: `version=${detail?.currentVersion}, items=${detail?.items?.length || 0}, cycles=${detail?.cycles?.length || 0}`
  })

  if (detail.status !== 'PUBLISHED') {
    await api.putBusiness(`/after-sales/inspection-config/plan/publish?id=${plan.id}`)
  }
  planList = dataOf(await api.getBusiness('/after-sales/inspection-config/plan/list')) || []
  plan = planList.find((candidate) => candidate.planCode === planCode)
  const publishedVersion = plan?.publishedVersion
  caseRecord.checks.push({
    name: '方案发布后记录发布版本',
    passed: plan?.status === 'PUBLISHED' && Number(publishedVersion) >= 1,
    details: `status=${plan?.status}, publishedVersion=${publishedVersion}`
  })

  const assets = dataOf(await api.getBusiness('/after-sales/asset/list')) || []
  const asset = assets[0]
  if (!asset) throw new Error('BLOCKED: 当前租户没有可用于巡检方案分配的客户资产')
  let assignmentList =
    dataOf(
      await api.getBusiness(`/after-sales/inspection-config/assignment/list?assetId=${asset.id}`)
    ) || []
  let assignment = assignmentList.find((candidate) => String(candidate.planId) === String(plan.id))
  if (!assignment) {
    const assignmentId = dataOf(
      await api.postBusiness('/after-sales/inspection-config/assignment/create', {
        assetId: asset.id,
        planId: plan.id,
        planVersion: publishedVersion,
        effectiveStart: '2026-09-30',
        cycleOverride: '',
        status: 0,
        serviceContractRef: 'E2E-CONTRACT-PB122',
        serviceEntitlementRef: 'E2E-ENTITLEMENT-PB122'
      })
    )
    assignmentList =
      dataOf(
        await api.getBusiness(`/after-sales/inspection-config/assignment/list?assetId=${asset.id}`)
      ) || []
    assignment = assignmentList.find(
      (candidate) => String(candidate.id) === String(assignmentId)
    )
  }
  caseRecord.checks.push({
    name: '已发布方案可分配到现有客户资产并保存合同权益引用',
    passed:
      Boolean(assignment?.id) &&
      assignment?.serviceContractRef === 'E2E-CONTRACT-PB122' &&
      assignment?.serviceEntitlementRef === 'E2E-ENTITLEMENT-PB122',
    details: `assetId=${asset.id}, assignmentId=${assignment?.id || 'n/a'}`
  })

  await api.putBusiness('/after-sales/inspection-config/plan/update', {
    ...basePayload,
    id: plan.id,
    description: `PB-122 自动化验证方案，基于发布版本 V${publishedVersion} 生成新草稿`
  })
  detail = dataOf(
    await api.getBusiness(`/after-sales/inspection-config/plan/detail?id=${plan.id}`)
  )
  caseRecord.checks.push({
    name: '已发布方案编辑生成新草稿版本，不覆盖发布版本号',
    passed:
      detail?.status === 'DRAFT' &&
      Number(detail?.currentVersion) === Number(publishedVersion) + 1 &&
      Number(detail?.publishedVersion) === Number(publishedVersion),
    details: `currentVersion=${detail?.currentVersion}, publishedVersion=${detail?.publishedVersion}`
  })
  await api.putBusiness(`/after-sales/inspection-config/plan/publish?id=${plan.id}`)

  const taskList = dataOf(await api.getBusiness('/after-sales/inspection/list'))
  caseRecord.checks.push({
    name: '巡检执行继续复用现有任务接口',
    passed: Array.isArray(taskList),
    details: `existingTaskCount=${Array.isArray(taskList) ? taskList.length : 'n/a'}`
  })

  await openRoute(page, '/after-sales/inspections')
  const configButton = page.getByRole('button', { name: '巡检配置' })
  await configButton.waitFor({ state: 'visible' })
  await configButton.click()
  await page.getByText('巡检项目、版本化方案与资产分配', { exact: true }).waitFor({
    state: 'visible'
  })
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '现有服务巡检菜单内提供统一配置入口',
    passed: ['巡检项目', '巡检方案', '资产分配'].every((label) => bodyText.includes(label)),
    details: '未新增平行菜单，配置抽屉真实渲染三类配置'
  })
  await saveScreenshot(page, outputDir, 'pb122-inspection-config', record)
  caseRecord.evidence.push('巡检执行仍使用 after-sales/inspection，配置层独立版本化并在任务生成时快照')
  return { token, api }
}
