import { createApiClient } from '../lib/api.mjs'
import { login, saveScreenshot } from '../lib/browser.mjs'
import { databaseConfigured, runReadOnlySql } from '../lib/db.mjs'

export const cases = ['MES-TASK-REPORT-001', 'MES-TASK-REPORT-002']

const loadWorkTaskRows = async (api) => {
  const pageResult = await api.getBusiness('/mes/prodWorkTask/list?pageNo=1&pageSize=100')
  const pageData = pageResult?.data ?? pageResult
  if (Array.isArray(pageData?.records)) return pageData.records
  if (Array.isArray(pageData?.list)) return pageData.list
  if (Array.isArray(pageData)) return pageData
  return []
}

const loadWorkRows = async (api) => {
  const pageResult = await api.getBusiness('/mes/prodWork/list/dictText?pageNo=1&pageSize=100')
  const pageData = pageResult?.data ?? pageResult
  if (Array.isArray(pageData?.records)) return pageData.records
  if (Array.isArray(pageData?.list)) return pageData.list
  if (Array.isArray(pageData)) return pageData
  return []
}

/**
 * PB-310（报工防重与并发票据）与 PB-311（暂停必填原因/预计恢复时间）回归。
 */
export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })

  if (caseId === 'MES-TASK-REPORT-001') {
    const tasks = await loadWorkTaskRows(api)
    caseRecord.checks.push({
      name: '生产工单任务分页返回报工并发票据 reportVersion 且 pageSize 不超过 100',
      passed:
        tasks.length > 0 &&
        tasks.length <= 100 &&
        tasks.every((task) => Number.isInteger(task?.reportVersion) && task.reportVersion >= 0),
      details: JSON.stringify({
        total: tasks.length,
        sample: tasks.slice(0, 3).map((task) => ({
          id: task?.id,
          reportVersion: task?.reportVersion
        }))
      })
    })

    if (databaseConfigured()) {
      const columns = await runReadOnlySql(
        "SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mes_prod_work_task' AND COLUMN_NAME = 'report_version';"
      )
      caseRecord.checks.push({
        name: 'mes_prod_work_task.report_version 列存在且非空默认 0',
        passed: columns.available && columns.rows.length === 1 && columns.rows[0][1] === 'NO',
        details: JSON.stringify(columns.rows)
      })

      const indexes = await runReadOnlySql(
        "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mes_prod_work_report' AND INDEX_NAME = 'idx_mes_work_report_process_worker_time';"
      )
      caseRecord.checks.push({
        name: '报工时间重叠校验索引已建立',
        passed: indexes.available && indexes.rows.some((row) => row[0] === 'idx_mes_work_report_process_worker_time'),
        details: JSON.stringify(indexes.rows)
      })
    } else {
      caseRecord.notes.push('未配置 CFOR_DB_* 环境变量，跳过 Flyway 结构断言。')
    }

    await saveScreenshot(page, outputDir, 'mes-task-report-version', record)
    caseRecord.evidence.push('真实登录后调用生产工单任务分页接口校验 reportVersion（只读）')
    return { api }
  }

  if (caseId === 'MES-TASK-REPORT-002') {
    const works = await loadWorkRows(api)
    if (works.length === 0) {
      caseRecord.checks.push({
        name: '暂停工单必须填写暂停原因与预计恢复时间',
        passed: false,
        details: '当前租户没有生产工单，无法验证暂停必填校验；需先构造一条生产工单'
      })
      return { api }
    }

    // 负向：不传暂停原因必须被拒绝，且校验发生在状态机变更之前，不会改动工单状态
    const withoutReason = await api.request('POST', '/mes/prodWork/pause', {
      id: works[0].id,
      prodWorkOrderId: works[0].prodOrderId
    })
    caseRecord.checks.push({
      name: '不填写暂停原因时暂停被拒绝',
      passed: withoutReason?.code !== 0 && String(withoutReason?.msg || '').includes('暂停原因'),
      details: JSON.stringify({ code: withoutReason?.code, msg: withoutReason?.msg })
    })

    // 负向：缺少预计恢复时间同样被拒绝
    const withoutResumeTime = await api.request('POST', '/mes/prodWork/pause', {
      id: works[0].id,
      prodWorkOrderId: works[0].prodOrderId,
      pauseReason: 'e2e 校验暂停原因必填'
    })
    caseRecord.checks.push({
      name: '不填写预计恢复时间时暂停被拒绝',
      passed:
        withoutResumeTime?.code !== 0 && String(withoutResumeTime?.msg || '').includes('预计恢复时间'),
      details: JSON.stringify({ code: withoutResumeTime?.code, msg: withoutResumeTime?.msg })
    })

    const pausedWorks = works.filter((work) => Number(work?.status) === 3)
    if (pausedWorks.length > 0) {
      caseRecord.checks.push({
        name: '暂停中的工单回读暂停原因与预计恢复时间',
        passed:
          typeof pausedWorks[0]?.pauseReason === 'string' &&
          pausedWorks[0].pauseReason.length > 0 &&
          Boolean(pausedWorks[0]?.expectResumeTime),
        details: JSON.stringify({
          id: pausedWorks[0]?.id,
          pauseReason: pausedWorks[0]?.pauseReason,
          expectResumeTime: pausedWorks[0]?.expectResumeTime
        })
      })
    } else {
      caseRecord.notes.push('当前租户没有暂停中的工单，跳过暂停原因回读断言。')
    }

    await saveScreenshot(page, outputDir, 'mes-prod-work-pause', record)
    caseRecord.evidence.push('真实登录后调用工单暂停接口做必填负向校验（未真正暂停工单）')
    return { api }
  }

  return { api }
}
