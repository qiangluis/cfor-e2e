import fs from 'node:fs'
import path from 'node:path'
import { config, environmentSummary } from '../config/index.mjs'

export function ensureDir (directory) {
  fs.mkdirSync(directory, { recursive: true })
  return directory
}

export function createRunRecord ({ selectedSuites = [], selectedCases = [] } = {}) {
  return {
    runId: `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${process.pid}`,
    startedAt: new Date().toISOString(),
    environment: environmentSummary(),
    selectedSuites,
    selectedCases,
    cases: [],
    api: [],
    screenshots: [],
    consoleErrors: [],
    consoleErrorDetails: [],
    requestFailures: [],
    pageErrors: [],
    failedApiResponses: []
  }
}

export function createCaseRecord (definition) {
  return {
    id: definition.id,
    caseId: definition.id,
    suite: definition.suite,
    title: definition.title,
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    checks: [],
    evidence: [],
    notes: [],
    durationMs: 0
  }
}

export function finishCase (caseRecord, status, details = '') {
  caseRecord.status = status
  caseRecord.finishedAt = new Date().toISOString()
  if (details) caseRecord.notes.push(details)
}

export function addCheck (caseRecord, name, passed, details = '') {
  caseRecord.checks.push({ name, passed: Boolean(passed), details })
  return Boolean(passed)
}

export function caseOutcome ({ failedChecks, partial, hasAssertions, result } = {}) {
  if (failedChecks?.length) {
    return { status: 'FAIL', note: `失败断言 ${failedChecks.length} 个` }
  }
  if (result?.notImplemented || result?.designed || result?.partial) {
    return { status: 'PARTIAL', note: result.note || '步骤尚未实现' }
  }
  if (partial) {
    return { status: 'PARTIAL', note: '已执行现有步骤，但完整业务闭环仍待补证据' }
  }
  if (!hasAssertions) {
    return { status: 'PARTIAL', note: '未执行任何有效断言，不能登记通过' }
  }
  return { status: 'PASS', note: '' }
}

export function caseErrorStatus (error, checks = []) {
  if (checks.some((check) => check.passed === false)) return 'FAIL'
  return String(error.message || error).startsWith('BLOCKED:') ? 'BLOCKED' : 'FAIL'
}

export function isRunPassed (record) {
  return record.cases.some((item) => item.status === 'PASS') &&
    record.cases.every((item) =>
      item.status === 'PASS' ||
      (item.status === 'SKIPPED' && item.notes?.includes('断点续跑：此前已通过'))
    )
}

export async function writeReport (record) {
  const outputDir = ensureDir(path.join(config.outputRoot, record.runId))
  ensureDir(path.join(outputDir, 'screenshots'))
  ensureDir(path.join(outputDir, 'trace'))
  record.finishedAt = new Date().toISOString()
  record.outputDir = outputDir
  record.passed = isRunPassed(record)

  const resultFile = path.join(outputDir, 'result.json')
  fs.writeFileSync(resultFile, JSON.stringify(record, null, 2))

  const passed = record.cases.filter((item) => item.status === 'PASS').length
  const partial = record.cases.filter((item) => item.status === 'PARTIAL').length
  const failed = record.cases.filter((item) => ['FAIL', 'BLOCKED'].includes(item.status)).length
  const skipped = record.cases.filter((item) => item.status === 'SKIPPED').length
  const lines = [
    `# CFOR E2E 回归报告（${record.runId}）`,
    '',
    `- 环境：${record.environment.target || config.target}`,
    `- 前端：${record.environment.webBase || config.webBase}`,
    `- 后端：${record.environment.apiBase || config.apiUrl}`,
    `- 时间：${record.finishedAt}`,
    `- 用例：${record.cases.length}，通过 ${passed}，部分 ${partial}，失败 ${failed}，跳过 ${skipped}`,
    '',
    '| 用例 | 套件 | 状态 | 耗时(ms) | 备注 |',
    '|---|---|---|---:|---|'
  ]
  for (const item of record.cases) {
    const note = (item.notes || []).join(' ').replace(/\|/g, '/')
    lines.push(`| ${item.id} | ${item.suite} | ${item.status} | ${item.durationMs || 0} | ${note} |`)
  }
  lines.push('', '## 分层断言明细', '')
  for (const item of record.cases) {
    lines.push(`### ${item.id}（${item.status}）`)
    for (const check of item.checks || []) {
      lines.push(`- [${check.passed ? 'x' : ' '}] ${check.name}${check.details ? `（${check.details}）` : ''}`)
    }
    for (const evidence of item.evidence || []) lines.push(`- 证据：${evidence}`)
    lines.push('')
  }
  if (record.failedApiResponses?.length) {
    lines.push('## API 失败', '')
    for (const failure of record.failedApiResponses) {
      lines.push(`- ${failure.status} ${failure.method} ${failure.url}`)
    }
  }
  fs.writeFileSync(path.join(outputDir, 'summary.md'), `${lines.join('\n')}\n`)
  return { outputDir, resultFile }
}
