import { createApiClient } from '../lib/api.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { ApsSchedulingFixture } from '../fixtures/mes-aps-write.mjs'

export const cases = ['MES-APS-001', 'MES-APS-002']

const SCHEME_STATUSES = new Set([
  'DRAFT',
  'CALCULATING',
  'PENDING_CONFIRM',
  'PUBLISHED',
  'VOIDED'
])

const GATE_CODES = ['MATERIAL', 'EQUIPMENT', 'TEAM', 'CALENDAR']

const unwrap = (response, label) => {
  assertBusinessSuccess(response, label)
  return response && Object.prototype.hasOwnProperty.call(response, 'data')
    ? response.data
    : response
}

const pageRows = (response, label) => {
  const data = unwrap(response, label)
  const rows = Array.isArray(data?.list)
    ? data.list
    : Array.isArray(data?.records)
      ? data.records
      : []
  return { data, rows }
}

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
  const fixture = new ApsSchedulingFixture(api, record, caseRecord.id, {
    calculate: true,
    withOpeningInventory: true
  })
  try {
    await fixture.setup(caseRecord)
    const versionId = fixture.versionId

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
        GATE_CODES.every((code) =>
          items.some((item) => item.code === code && typeof item.passed === 'boolean')),
      details: JSON.stringify({
        versionId,
        passed: gate?.passed,
        codes: items.map((item) => item.code),
        passedCodes: items.filter((item) => item.passed).map((item) => item.code)
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
      details: JSON.stringify({ versionId, count: Array.isArray(changes) ? changes.length : null })
    })

    // 非本版本的排产结果必须被受控重排审批入口拒绝。
    const rejected = await api.request('POST', '/mes/aps/scheduling/change/submit-approval', {
      versionId,
      resultIds: [-1],
      reason: `${fixture.marker} 受控重排负向校验`
    }, {
      expectedBusinessRejection: {
        code: 500,
        message: '存在不属于当前排产版本的受影响任务',
        allowServiceCode: true
      }
    })
    const rejectedMessage = rejected?.msg || rejected?.message || ''
    caseRecord.checks.push({
      name: '非本版本排产结果的受控重排审批被拒绝',
      passed:
        rejected?.code !== 0 &&
        typeof rejectedMessage === 'string' &&
        rejectedMessage.length > 0,
      details: JSON.stringify({ code: rejected?.code, msg: rejectedMessage })
    })

    await openRoute(page, '/mes/aps/scheduling-manage')
    await saveScreenshot(page, outputDir, 'mes-aps-publish-gate', record)
    caseRecord.evidence.push(
      `正式创建 ${fixture.marker} 工单与排产版本 ${versionId}，执行排产计算后校验发布门禁、变更审计和非本版本审批拒绝`
    )
    return { api }
  } finally {
    await fixture.cleanup(caseRecord)
  }
}

// PB-303/304：五状态机 + 计算快照 + 比较指标
const runSchemeSnapshotCase = async ({ page, api, record, caseRecord, outputDir }) => {
  const fixture = new ApsSchedulingFixture(api, record, caseRecord.id, {
    calculate: true,
    withOpeningInventory: true
  })
  try {
    await fixture.setup(caseRecord)
    const versionId = String(fixture.versionId)

    const pageResult = await api.getBusiness('/mes/aps/scheduling/page?pageNo=1&pageSize=100')
    const { data: pageData, rows } = pageRows(pageResult, '排产版本分页')
    const ownRows = rows.filter((row) => String(row?.id) === versionId)
    caseRecord.checks.push({
      name: '排产版本分页返回方案状态、算法版本、生成时间与快照字段且分页不超过 100',
      passed:
        typeof pageData?.total === 'number' &&
        rows.length <= 100 &&
        ownRows.length === 1 &&
        SCHEME_STATUSES.has(ownRows[0]?.schemeStatus) &&
        typeof ownRows[0]?.algorithmVersion === 'string' &&
        ownRows[0].algorithmVersion.length > 0 &&
        ownRows[0]?.generatedTime != null &&
        typeof ownRows[0]?.inputSnapshot === 'string' &&
        ownRows[0].inputSnapshot.length > 0,
      details: JSON.stringify({
        versionId,
        total: pageData?.total,
        count: rows.length,
        row: ownRows[0]
          ? {
              schemeStatus: ownRows[0].schemeStatus,
              algorithmVersion: ownRows[0].algorithmVersion,
              generatedTime: ownRows[0].generatedTime,
              inputSnapshotLength: ownRows[0].inputSnapshot?.length
            }
          : null
      })
    })

    const compareResult = await api.getBusiness(
      `/mes/aps/scheduling/compare?versionIds=${encodeURIComponent(versionId)}`
    )
    const compareData = compareResult?.data ?? compareResult
    const first = Array.isArray(compareData) ? compareData[0] : compareData
    caseRecord.checks.push({
      name: '排产方案比较返回换线次数与缺料风险指标',
      passed:
        first != null &&
        Number.isInteger(first?.changeoverCount) &&
        Number.isInteger(first?.shortageRiskCount),
      details: JSON.stringify({
        versionId,
        changeoverCount: first?.changeoverCount,
        shortageRiskCount: first?.shortageRiskCount
      })
    })

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
    caseRecord.evidence.push(
      `正式创建 ${fixture.marker} 排产版本 ${versionId} 并执行排产计算，回读五状态字段、输入快照与比较指标`
    )
    return { api }
  } finally {
    await fixture.cleanup(caseRecord)
  }
}
