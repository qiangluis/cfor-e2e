import { createApiClient } from '../lib/api.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { ExecutionWorkflowFixture } from '../fixtures/mes-execution-write.mjs'

export const cases = ['MES-MONITOR-001']

const unwrap = (response, label) => {
  assertBusinessSuccess(response, label)
  return response && Object.prototype.hasOwnProperty.call(response, 'data')
    ? response.data
    : response
}

/**
 * PB-312：生产执行看板车间数据权限过滤与预警下钻字段回归。
 *
 * 自动化只创建专属逾期工单并读取看板，不触发
 * /mes/monitor/alarms/dispatch，避免在环境中产生额外待办与站内通知。
 */
export const runCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })
  const fixture = new ExecutionWorkflowFixture(api, record, caseRecord.id, { overdue: true })
  try {
    await fixture.setup(caseRecord)

    const workplacesResult = await api.getBusiness('/mes/monitor/workplaces')
    const workplaces = workplacesResult?.data ?? workplacesResult
    caseRecord.checks.push({
      name: '车间列表按当前登录用户数据权限返回，且包含专属工单所属车间',
      passed:
        Array.isArray(workplaces) &&
        workplaces.some((workplace) => String(workplace?.id) === String(fixture.workplace.id)) &&
        workplaces.every(
          (workplace) =>
            workplace?.id != null &&
            typeof workplace?.name === 'string' &&
            workplace.name.length > 0
        ),
      details: JSON.stringify({
        count: Array.isArray(workplaces) ? workplaces.length : -1,
        workplaceId: fixture.workplace.id
      })
    })

    const dashboardResult = await api.getBusiness(
      `/mes/monitor/production-dashboard?workplaceId=${encodeURIComponent(fixture.workplace.id)}`
    )
    const dashboard = dashboardResult?.data ?? dashboardResult
    caseRecord.checks.push({
      name: '生产看板按车间返回 lines/alarms/trends 结构化数据',
      passed:
        Array.isArray(dashboard?.lines) &&
        Array.isArray(dashboard?.alarms) &&
        Array.isArray(dashboard?.trends),
      details: JSON.stringify({
        workplaceId: fixture.workplace.id,
        lines: dashboard?.lines?.length ?? -1,
        alarms: dashboard?.alarms?.length ?? -1,
        trends: dashboard?.trends?.length ?? -1
      })
    })

    const alarms = Array.isArray(dashboard?.alarms) ? dashboard.alarms : []
    const ownAlarms = alarms.filter(
      (alarm) => String(alarm?.sourceId) === String(fixture.works[0].id)
    )
    caseRecord.checks.push({
      name: '真实逾期专属工单产生带 alarmKey/sourceType/sourceId 的可下钻预警',
      passed:
        ownAlarms.length === 1 &&
        ownAlarms[0]?.sourceType === 'WORK' &&
        ownAlarms[0]?.alarmKey === `WORK_OVERDUE:${fixture.works[0].id}` &&
        String(ownAlarms[0]?.sourceId) === String(fixture.works[0].id),
      details: JSON.stringify(ownAlarms.slice(0, 3))
    })

    const drilldown = unwrap(await api.getBusiness(
      `/mes/prodWork/queryById?id=${encodeURIComponent(fixture.works[0].id)}`
    ), '预警工单下钻')
    caseRecord.checks.push({
      name: '预警 sourceId 下钻回读同一专属工单且所有权一致',
      passed:
        String(drilldown?.id) === String(fixture.works[0].id) &&
        drilldown?.remark === fixture.marker,
      details: JSON.stringify({
        workId: drilldown?.id,
        remark: drilldown?.remark,
        marker: fixture.marker
      })
    })

    await openRoute(page, '/mes/monitor', { readyText: '生产看板' }).catch(() => null)
    await saveScreenshot(page, outputDir, 'mes-monitor-workplace-alarms', record)
    caseRecord.evidence.push(
      `真实创建 ${fixture.marker} 逾期工单并读取生产看板聚合与工单下钻；未调用 alarms/dispatch`
    )
    return { api }
  } finally {
    await fixture.cleanup(caseRecord)
  }
}
