import { createApiClient } from '../lib/api.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
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
  return pauseWorkPageRows(pageResult)
}

export const pauseWorkPageRows = (result) => {
  const data = result?.data
  const rows = Array.isArray(data) ? data : data?.records ?? data?.list
  const total = data?.total == null ? rows?.length : Number(data.total)
  if (
    !isBusinessSuccess(result) ||
    !Array.isArray(rows) ||
    rows.length > 100 ||
    !Number.isSafeInteger(total) ||
    total < rows.length ||
    (rows.length === 0 && total !== 0) ||
    rows.some((row) => row?.id == null || String(row.id).trim() === '')
  ) {
    throw new Error('生产工单分页响应无效，不能视为缺少正式单据')
  }
  return rows
}

export const isPauseValidationRejection = (result, message) =>
  result?.code === 500 && (result?.msg ?? result?.message) === message

export const pausedWorkRows = (works) =>
  works.filter((work) => work?.status === 3 || work?.status === '3')

export const hasPausedWorkReadback = (works) => {
  const paused = pausedWorkRows(works)
  return paused.length > 0 && paused.every((work) =>
    typeof work.pauseReason === 'string' &&
    work.pauseReason.trim().length > 0 &&
    typeof work.expectResumeTime === 'string' &&
    Number.isFinite(Date.parse(work.expectResumeTime))
  )
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
        tasks.length === 0 ||
        (tasks.length <= 100 &&
          tasks.every((task) => Number.isInteger(task?.reportVersion) && task.reportVersion >= 0)),
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
    return tasks.length > 0
      ? { api }
      : {
          api,
          partial: true,
          note: '当前租户没有生产工单任务，reportVersion 实际字段待补业务前置后复测'
        }
  }

  if (caseId === 'MES-TASK-REPORT-002') {
    const works = await loadWorkRows(api)
    caseRecord.checks.push({
      name: '生产工单真实分页可读取，空集不等于暂停业务闭环',
      passed: true,
      details: `works=${works.length}`
    })

    // Mandatory-field checks precede lookup; never send a real work ID to this write API.
    const withoutReason = await api.request('POST', '/mes/prodWork/pause', {
      id: '__not_exists__',
      prodWorkOrderId: '__not_exists__'
    })
    caseRecord.checks.push({
      name: '不填写暂停原因时暂停被拒绝',
      passed: isPauseValidationRejection(withoutReason, '暂停原因不能为空'),
      details: JSON.stringify({
        code: withoutReason?.code,
        msg: withoutReason?.msg ?? withoutReason?.message
      })
    })

    const withoutResumeTime = await api.request('POST', '/mes/prodWork/pause', {
      id: '__not_exists__',
      prodWorkOrderId: '__not_exists__',
      pauseReason: 'e2e 校验暂停原因必填'
    })
    caseRecord.checks.push({
      name: '不填写预计恢复时间时暂停被拒绝',
      passed: isPauseValidationRejection(withoutResumeTime, '预计恢复时间不能为空'),
      details: JSON.stringify({
        code: withoutResumeTime?.code,
        msg: withoutResumeTime?.msg ?? withoutResumeTime?.message
      })
    })

    const pausedWorks = pausedWorkRows(works)
    if (pausedWorks.length > 0) {
      caseRecord.checks.push({
        name: '暂停中的工单回读暂停原因与预计恢复时间',
        passed: hasPausedWorkReadback(works),
        details: `pausedWorks=${pausedWorks.length}`
      })
    } else {
      caseRecord.notes.push('当前租户没有正式暂停工单，必填负向验证不能替代暂停字段落库回读。')
    }

    await openRoute(page, '/mes/produce/work-order', {
      readySelector: '.search-form input[placeholder="请输入工单编号"]'
    })
    await saveScreenshot(page, outputDir, 'mes-prod-work-pause', record)
    caseRecord.evidence.push('真实生产工单页面、正式工单只读查询和不存在 ID 的暂停必填负向校验；未暂停正式工单')
    return pausedWorks.length > 0
      ? { api }
      : {
          api,
          partial: true,
          note: `${works.length === 0 ? '当前租户没有正式生产工单；' : ''}缺少正式暂停工单，原因/预计恢复时间落库回读未验证，不创建或暂停共享业务数据`
        }
  }

  return { api }
}
