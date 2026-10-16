import { createApiClient, isBusinessRejection } from '../lib/api.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { databaseConfigured, runReadOnlySql } from '../lib/db.mjs'
import { ExecutionWorkflowFixture } from '../fixtures/mes-execution-write.mjs'

export const cases = ['MES-TASK-REPORT-001', 'MES-TASK-REPORT-002']

export const catalogAssertions = {
  'MES-TASK-REPORT-001': [
    '生产工单任务分页返回 reportVersion 且为不小于 0 的整数',
    'mes_prod_work_task.report_version 列存在且非空默认 0',
    '报工时间重叠校验索引 idx_mes_work_report_process_worker_time 已建立'
  ],
  'MES-TASK-REPORT-002': [
    '不填写暂停原因时暂停被拒绝',
    '不填写预计恢复时间时暂停被拒绝',
    '暂停中的工单回读暂停原因与预计恢复时间'
  ]
}

const evidenceNames = {
  'MES-TASK-REPORT-001': [
    ['生产工单任务分页返回报工并发票据 reportVersion 且 pageSize 不超过 100'],
    ['mes_prod_work_task.report_version 列存在且非空默认 0'],
    ['报工时间重叠校验索引已建立']
  ],
  'MES-TASK-REPORT-002': [
    ['专属 AUTOTEST 工单已正式开工并回读为进行中', '不填写暂停原因时专属工单暂停被拒绝，且状态仍为进行中'],
    ['专属 AUTOTEST 工单已正式开工并回读为进行中', '不填写预计恢复时间时专属工单暂停被拒绝'],
    ['专属工单暂停后真实回读暂停原因与预计恢复时间']
  ]
}

export function finishCatalog (caseRecord, caseId) {
  for (const row of caseRecord.catalogAssertions) {
    const names = evidenceNames[caseId][row.index]
    const checks = names.map((name) => caseRecord.checks.find((check) => check.name === name))
    row.evidenceChecks = names.filter((_, index) => checks[index] != null)
    row.status = checks.some((check) => check?.passed === false) ? 'FAILED'
      : checks.every((check) => check?.passed === true) ? 'VERIFIED' : 'GAP'
  }
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((row) => row.status !== 'VERIFIED').map((row) => row.assertion)
  caseRecord.catalogComplete = caseRecord.remainingAssertions.length === 0
  return { partial: !caseRecord.catalogComplete }
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
  isBusinessRejection(result) &&
  result.code === 400 &&
  (result.msg ?? result.message) === message

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
export const runCase = async (context, dependencies = {}) => {
  const { caseId, caseRecord } = context
  if (!cases.includes(caseId)) throw new Error(`Unsupported task report case: ${caseId}`)
  caseRecord.catalogAssertions = catalogAssertions[caseId].map((assertion, index) => ({
    index, assertion, status: 'GAP', evidenceChecks: []
  }))
  let result
  try {
    result = await runPreparedCase(context, dependencies)
  } finally {
    finishCatalog(caseRecord, caseId)
  }
  return { ...result, partial: !caseRecord.catalogComplete }
}

const runPreparedCase = async ({ caseId, page, record, caseRecord, outputDir }, dependencies) => {
  const token = await (dependencies.login || login)(page)
  const api = (dependencies.createApiClient || createApiClient)({ token, record })
  const Fixture = dependencies.ExecutionWorkflowFixture || ExecutionWorkflowFixture
  const sql = dependencies.sql || runReadOnlySql

  if (caseId === 'MES-TASK-REPORT-001') {
    const fixture = new Fixture(api, record, caseId, { withOpeningInventory: true })
    try {
      await fixture.setup(caseRecord)
      const result = await api.getBusiness(
        `/mes/prodWorkTask/list?pageNo=1&pageSize=100&workTicketId=${encodeURIComponent(fixture.works[0].id)}`
      )
      const tasks = pauseWorkPageRows(result)
      caseRecord.checks.push({
        name: '生产工单任务分页返回报工并发票据 reportVersion 且 pageSize 不超过 100',
        passed:
          tasks.length > 0 &&
          tasks.some((task) => String(task.id) === String(fixture.tasks[0].id)) &&
          tasks.every((task) => String(task.workTicketId) === String(fixture.works[0].id) &&
            Number.isInteger(task?.reportVersion) && task.reportVersion >= 0),
        details: JSON.stringify({
          total: tasks.length,
          sample: tasks.slice(0, 3).map((task) => ({
            id: task?.id,
            reportVersion: task?.reportVersion
          }))
        })
      })

      if ((dependencies.databaseConfigured || databaseConfigured)()) {
        const columns = await sql(
          "SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mes_prod_work_task' AND COLUMN_NAME = 'report_version';"
        )
        caseRecord.checks.push({
          name: 'mes_prod_work_task.report_version 列存在且非空默认 0',
          passed: columns.available && columns.rows.length === 1 &&
            columns.rows[0][0] === 'report_version' && columns.rows[0][1] === 'NO' &&
            String(columns.rows[0][2]) === '0',
          details: JSON.stringify(columns.rows)
        })

        const indexes = await sql(
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

      await (dependencies.saveScreenshot || saveScreenshot)(page, outputDir, 'mes-task-report-version', record)
      caseRecord.evidence.push(`本轮专属工单 ${fixture.works[0].id} 的任务分页非空回读 reportVersion；期初库存夹具按现有 MES 合法链路创建并清理`)
      return { api }
    } finally {
      await fixture.cleanup(caseRecord)
    }
  }

  if (caseId === 'MES-TASK-REPORT-002') {
    const fixture = new Fixture(api, record, caseId, { withOpeningInventory: true })
    try {
      await fixture.setup(caseRecord)
      const started = await fixture.startWork()
      const readWork = async () => {
        const response = await api.getBusiness(
          `/mes/prodWork/queryById?id=${encodeURIComponent(fixture.works[0].id)}`
        )
        return response?.data ?? response
      }
      caseRecord.checks.push({
        name: '专属 AUTOTEST 工单已正式开工并回读为进行中',
        passed: Number(started.status) === 2 && started.remark === fixture.marker,
        details: JSON.stringify({
          workId: fixture.works[0].id,
          status: started.status,
          marker: fixture.marker
        })
      })

      const withoutReason = await api.request('POST', '/mes/prodWork/pause', {
        id: fixture.works[0].id,
        prodWorkOrderId: fixture.works[0].id
      }, {
        expectedBusinessRejection: {
          code: 400,
          message: '暂停原因不能为空'
        }
      })
      caseRecord.checks.push({
        name: '不填写暂停原因时专属工单暂停被拒绝，且状态仍为进行中',
        passed:
          isPauseValidationRejection(withoutReason, '暂停原因不能为空') &&
          Number((await readWork())?.status) === 2,
        details: JSON.stringify({
          code: withoutReason?.code,
          msg: withoutReason?.msg ?? withoutReason?.message
        })
      })

      const withoutResumeTime = await api.request('POST', '/mes/prodWork/pause', {
        id: fixture.works[0].id,
        prodWorkOrderId: fixture.works[0].id,
        pauseReason: fixture.marker
      }, {
        expectedBusinessRejection: {
          code: 400,
          message: '预计恢复时间不能为空'
        }
      })
      caseRecord.checks.push({
        name: '不填写预计恢复时间时专属工单暂停被拒绝',
        passed: isPauseValidationRejection(withoutResumeTime, '预计恢复时间不能为空'),
        details: JSON.stringify({
          code: withoutResumeTime?.code,
          msg: withoutResumeTime?.msg ?? withoutResumeTime?.message
        })
      })

      const expectedResumeTime = new Date(Date.now() + 3600000).toISOString()
      const paused = await fixture.pauseWork(fixture.marker, expectedResumeTime)
      caseRecord.checks.push({
        name: '专属工单暂停后真实回读暂停原因与预计恢复时间',
        passed:
          Number(paused.status) === 3 &&
          paused.pauseReason === fixture.marker &&
          typeof paused.expectResumeTime === 'string' &&
          Number.isFinite(Date.parse(paused.expectResumeTime)),
        details: JSON.stringify({
          workId: fixture.works[0].id,
          status: paused.status,
          pauseReason: paused.pauseReason,
          expectResumeTime: paused.expectResumeTime
        })
      })

      const resumed = await fixture.resumeWork()
      caseRecord.checks.push({
        name: '专属工单恢复后状态回读为进行中且保留暂停历史',
        passed:
          Number(resumed.status) === 2 &&
          resumed.pauseReason === fixture.marker &&
          resumed.resumeTime != null,
        details: JSON.stringify({
          status: resumed.status,
          pauseReason: resumed.pauseReason,
          resumeTime: resumed.resumeTime
        })
      })

      await (dependencies.openRoute || openRoute)(page, '/mes/produce/work-order', {
        readySelector: '.search-form input[placeholder="请输入工单编号"]'
      })
      await (dependencies.saveScreenshot || saveScreenshot)(page, outputDir, 'mes-prod-work-pause', record)
      caseRecord.evidence.push(
        `真实创建 ${fixture.marker} 工单，开工后校验暂停必填、暂停落库回读并恢复`
      )
      return { api }
    } finally {
      await fixture.cleanup(caseRecord)
    }
  }

  return { api }
}
