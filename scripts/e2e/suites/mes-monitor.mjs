import { createApiClient } from '../lib/api.mjs'
import { login, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['MES-MONITOR-001']

/**
 * PB-312：生产执行看板车间数据权限过滤与预警下钻字段回归。
 *
 * 只做只读校验，不触发 /mes/monitor/alarms/dispatch，避免在环境内产生待办与站内通知。
 */
export const runCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })

  const workplacesResult = await api.getBusiness('/mes/monitor/workplaces')
  const workplaces = workplacesResult?.data ?? workplacesResult
  caseRecord.checks.push({
    name: '车间列表按当前登录用户数据权限返回，字段完整',
    passed:
      Array.isArray(workplaces) &&
      workplaces.every(
        (workplace) =>
          workplace?.id != null &&
          typeof workplace?.name === 'string' &&
          workplace.name.length > 0
      ),
    details: JSON.stringify({
      count: Array.isArray(workplaces) ? workplaces.length : -1,
      sample: Array.isArray(workplaces)
        ? workplaces.slice(0, 3).map((item) => ({ id: item.id, name: item.name }))
        : null
    })
  })

  if (!Array.isArray(workplaces) || workplaces.length === 0) {
    caseRecord.checks.push({
      name: '生产看板返回预警下钻字段（alarmKey/sourceType/sourceId）',
      passed: false,
      details: '当前登录账号没有可见车间，无法验证看板预警字段；需先为账号配置部门与车间归属'
    })
    return { api }
  }

  const selected = workplaces[0]
  const dashboardResult = await api.getBusiness(
    `/mes/monitor/production-dashboard?workplaceId=${encodeURIComponent(selected.id)}`
  )
  const dashboard = dashboardResult?.data ?? dashboardResult

  caseRecord.checks.push({
    name: '生产看板按车间返回结构化数据',
    passed:
      Array.isArray(dashboard?.lines) &&
      Array.isArray(dashboard?.alarms) &&
      Array.isArray(dashboard?.trends),
    details: JSON.stringify({
      workplaceId: selected.id,
      lines: dashboard?.lines?.length ?? -1,
      alarms: dashboard?.alarms?.length ?? -1,
      trends: dashboard?.trends?.length ?? -1
    })
  })

  const alarms = Array.isArray(dashboard?.alarms) ? dashboard.alarms : []
  const malformed = alarms.filter(
    (alarm) =>
      typeof alarm?.alarmKey !== 'string' ||
      alarm.alarmKey.length === 0 ||
      !['DEVICE', 'WORK'].includes(alarm?.sourceType) ||
      String(alarm?.sourceId || '').length === 0
  )
  caseRecord.checks.push({
    name: '每条预警都带来源唯一键，可下钻到设备或生产工单',
    passed: alarms.length > 0 && malformed.length === 0,
    details: JSON.stringify({
      alarms: alarms.length,
      malformed: malformed.length,
      sample: alarms.slice(0, 3).map((alarm) => ({
        alarmKey: alarm?.alarmKey,
        sourceType: alarm?.sourceType,
        sourceId: alarm?.sourceId
      }))
    })
  })

  await saveScreenshot(page, outputDir, 'mes-monitor-workplace-alarms', record)
  caseRecord.evidence.push('真实登录后调用生产看板车间列表与看板聚合接口（只读）')
  return { api }
}
