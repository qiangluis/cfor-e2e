import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['MES-APS-001', 'MES-APS-002']

const SCHEME_STATUSES = new Set([
  'DRAFT',
  'CALCULATING',
  'PENDING_CONFIRM',
  'PUBLISHED',
  'VOIDED'
])

const GATE_CODES = ['MATERIAL', 'EQUIPMENT', 'TEAM', 'CALENDAR']

export const runCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })

  if (caseRecord.id === 'MES-APS-002') {
    return runPublishGateCase({ page, api, record, caseRecord, outputDir })
  }
  return runSchemeSnapshotCase({ page, api, record, caseRecord, outputDir })
}

// PB-305：发布门禁 + 受控重排变更审计
const runPublishGateCase = async ({ page, api, record, caseRecord, outputDir }) => {
  const pageResult = await api.getBusiness('/mes/aps/scheduling/page?pageNo=1&pageSize=100')
  const pageData = pageResult?.data ?? pageResult
  const rows = Array.isArray(pageData?.list)
    ? pageData.list
    : Array.isArray(pageData?.records)
      ? pageData.records
      : []

  if (rows.length === 0) {
    caseRecord.notes.push('当前租户没有排产版本样本，无法验收发布门禁与受控重排。')
    await openRoute(page, '/mes/aps/scheduling-manage', { readyText: '排产' })
    await saveScreenshot(page, outputDir, 'mes-aps-publish-gate', record)
    return {
      api,
      notImplemented: true,
      note: '当前租户没有排产版本样本，发布门禁待补数据复验'
    }
  }

  const versionId = rows[0].id
  const gateResult = await api.getBusiness(
    `/mes/aps/scheduling/publish-gate?versionId=${versionId}`
  )
  const gate = gateResult?.data ?? gateResult
  const items = Array.isArray(gate?.items) ? gate.items : []
  caseRecord.checks.push({
    name: '排产发布门禁返回齐套、设备、班组、日历四项明细',
    passed:
      typeof gate?.passed === 'boolean' &&
      items.length === 4 &&
      GATE_CODES.every((code) => items.some((item) => item.code === code && typeof item.passed === 'boolean')),
    details: JSON.stringify({
      versionId,
      passed: gate?.passed,
      codes: items.map((item) => item.code)
    })
  })

  const changeResult = await api.getBusiness(
    `/mes/aps/scheduling/change/list?versionId=${versionId}`
  )
  const changes = changeResult?.data ?? changeResult
  caseRecord.checks.push({
    name: '排产变更审计可按版本查询且带审批状态字段',
    passed:
      Array.isArray(changes) &&
      changes.every(
        (item) =>
          Object.prototype.hasOwnProperty.call(item, 'approvalStatus') &&
          Object.prototype.hasOwnProperty.call(item, 'consumed') &&
          Object.prototype.hasOwnProperty.call(item, 'beforeValue') &&
          Object.prototype.hasOwnProperty.call(item, 'afterValue')
      ),
    details: JSON.stringify({ count: Array.isArray(changes) ? changes.length : null })
  })

  // 非本版本的排产结果必须被受控重排审批入口拒绝（只读负向校验，不产生审批实例）。
  const rejected = await api.request('POST', '/mes/aps/scheduling/change/submit-approval', {
    versionId,
    resultIds: [-1],
    reason: 'E2E 受控重排校验'
  })
  caseRecord.checks.push({
    name: '非本版本排产结果的受控重排审批被拒绝',
    passed: rejected?.code !== 0 && typeof rejected?.msg === 'string' && rejected.msg.length > 0,
    details: JSON.stringify({ code: rejected?.code, msg: rejected?.msg })
  })

  await openRoute(page, '/mes/aps/scheduling-manage')
  await saveScreenshot(page, outputDir, 'mes-aps-publish-gate', record)
  caseRecord.evidence.push('真实登录后调用发布门禁、变更审计与受控重排审批接口')
  return { api }
}

// PB-303/304：五状态机 + 计算快照 + 比较指标
const runSchemeSnapshotCase = async ({ page, api, record, caseRecord, outputDir }) => {
  const pageResult = await api.getBusiness('/mes/aps/scheduling/page?pageNo=1&pageSize=100')
  const pageData = pageResult?.data ?? pageResult
  const rows = Array.isArray(pageData?.list)
    ? pageData.list
    : Array.isArray(pageData?.records)
      ? pageData.records
      : []
  caseRecord.checks.push({
    name: '排产版本分页返回方案状态、算法版本、生成时间与快照字段且分页不超过 100',
    passed:
      typeof pageData?.total === 'number' &&
      rows.length <= 100 &&
      rows.every(
        (row) =>
          row?.id &&
          SCHEME_STATUSES.has(row?.schemeStatus) &&
          Object.prototype.hasOwnProperty.call(row, 'algorithmVersion') &&
          Object.prototype.hasOwnProperty.call(row, 'generatedTime') &&
          Object.prototype.hasOwnProperty.call(row, 'inputSnapshot')
      ),
    details: JSON.stringify({ total: pageData?.total, count: rows.length })
  })

  let missingData = false
  if (rows.length > 0) {
    const firstId = rows[0].id
    const compareResult = await api.getBusiness(
      `/mes/aps/scheduling/compare?versionIds=${encodeURIComponent(firstId)}`
    )
    const compareData = compareResult?.data ?? compareResult
    const first = Array.isArray(compareData) ? compareData[0] : compareData
    caseRecord.checks.push({
      name: '排产方案比较返回换线次数与缺料风险指标',
      passed:
        first !== undefined &&
        first !== null &&
        Object.prototype.hasOwnProperty.call(first, 'changeoverCount') &&
        Object.prototype.hasOwnProperty.call(first, 'shortageRiskCount'),
      details: JSON.stringify({
        changeoverCount: first?.changeoverCount,
        shortageRiskCount: first?.shortageRiskCount
      })
    })
    caseRecord.evidence.push('真实登录后调用排产版本分页与方案比较接口')
  } else {
    missingData = true
    caseRecord.notes.push('当前租户没有排产版本样本，无法验收方案比较指标。')
  }

  await openRoute(page, '/mes/aps/scheduling-manage', { readyText: '排产' })
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '智能排产页面可真实渲染',
    passed:
      new URL(page.url()).pathname === '/mes/aps/scheduling-manage' &&
      bodyText.includes('排产'),
    details: page.url()
  })

  await saveScreenshot(page, outputDir, 'mes-aps-scheduling', record)
  caseRecord.evidence.push('真实登录、排产分页接口、方案比较接口和浏览器截图')
  return {
    api,
    notImplemented: missingData,
    note: missingData ? '当前租户没有排产版本样本，方案比较待补数据复验' : undefined
  }
}
