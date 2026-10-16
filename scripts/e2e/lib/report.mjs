import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { config, environmentSummary } from '../config/index.mjs'
import { redact } from './redact.mjs'

const terminalStatuses = new Set(['PASS', 'SKIPPED', 'PARTIAL', 'BLOCKED', 'FAIL'])
const secretKey = /password|passwd|(?:^|_)pass(?:$|_)|pwd|secret|token|authorization|credential|cookie|private.?key/i
const isSecretKey = (key) => secretKey.test(key) && key !== 'RUNNING' && !terminalStatuses.has(key)

export class ReportPersistenceError extends Error {
  constructor (file, error) {
    super(`E2E report persistence failed: ${file} (${error.code || error.name || 'write error'})`, { cause: error })
    this.name = 'ReportPersistenceError'
    this.code = 'E2E_REPORT_PERSISTENCE_FAILED'
  }
}

export function reportSnapshot (value, { settings = config } = {}) {
  const secrets = new Set()
  const collect = (object) => {
    for (const [key, item] of Object.entries(object || {})) {
      if (item && typeof item === 'object') collect(item)
      else if (isSecretKey(key) && typeof item === 'string' && item) secrets.add(item)
    }
  }
  collect(settings)
  collect(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('CFOR_'))))
  const orderedSecrets = [...secrets].sort((left, right) => right.length - left.length)
  const text = (input) => {
    let output = input
    for (const secret of orderedSecrets) output = output.split(secret).join('[REDACTED]')
    output = output
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]')
      .replace(/((?:password|passwd|pwd|secret|(?:access|refresh)[_-]?token|authorization|credential|cookie|private[_-]?key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;&}\]]+)/gi, '$1[REDACTED]')
      .replace(/(\/\/)[^/\s"'<>]*@/g, '$1[REDACTED]@')
    return output
  }
  const ancestors = new Set()
  const visit = (item) => {
    if (typeof item === 'string') {
      if (/^\s*[{[]/.test(item)) {
        try { return text(JSON.stringify(visit(JSON.parse(item)))) } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
        }
      }
      return text(item)
    }
    if (typeof item === 'function') return '[Function]'
    if (typeof item === 'bigint') return String(item)
    if (!item || typeof item !== 'object') return item
    // Browser and Playwright payloads can contain back references; keep the report serializable.
    if (ancestors.has(item)) return '[Circular]'
    ancestors.add(item)
    try {
      if (item instanceof Error) {
        return visit({
          ...item,
          name: item.name,
          message: item.message,
          stack: item.stack,
          ...(item.cause !== undefined ? { cause: item.cause } : {}),
          ...(item.errors !== undefined ? { errors: item.errors } : {})
        })
      }
      if (item instanceof Date) return item.toISOString()
      if (Array.isArray(item)) return item.map(visit)
      return Object.fromEntries(Object.entries(item).map(([key, nested]) => [
        key, isSecretKey(key) || redact({ [key]: 'value' })[key] === '[REDACTED]'
          ? '[REDACTED]' : visit(nested)
      ]))
    } finally {
      ancestors.delete(item)
    }
  }
  return visit(value)
}

export function atomicWriteFile (file, contents, { fileSystem = fs } = {}) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  let descriptor
  try {
    fileSystem.mkdirSync(path.dirname(file), { recursive: true })
    descriptor = fileSystem.openSync(temporary, 'wx', 0o600)
    fileSystem.writeFileSync(descriptor, contents, 'utf8')
    fileSystem.fsyncSync(descriptor)
    fileSystem.closeSync(descriptor)
    descriptor = undefined
    fileSystem.renameSync(temporary, file)
  } catch (error) {
    if (descriptor !== undefined) {
      try { fileSystem.closeSync(descriptor) } catch {}
    }
    try { fileSystem.unlinkSync(temporary) } catch {}
    throw new ReportPersistenceError(file, error)
  }
}

export function safeCaseId (caseId) {
  if (typeof caseId !== 'string' || !caseId.trim()) throw new Error('Missing report case ID')
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(caseId)) return caseId
  const digest = createHash('sha256').update(caseId).digest('hex').slice(0, 16)
  return `${caseId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'case'}-${digest}`
}

function runPaths (record, outputRoot) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(record.runId || '')) throw new Error('Unsafe report run ID')
  const outputDir = path.resolve(outputRoot, record.runId)
  return {
    outputDir,
    progressFile: path.join(outputDir, 'progress.json'),
    caseDir: path.join(outputDir, 'cases'),
    resultFile: path.join(outputDir, 'result.json')
  }
}

function selectionState (record) {
  const ids = (record.cases || []).map((item, index) =>
    item.caseId || item.id || `__legacy_case_${index}`)
  const selected = record.selectedCases?.length ? [...record.selectedCases] : ids
  if (new Set(selected).size !== selected.length || new Set(ids).size !== ids.length ||
      ids.some((id) => !selected.includes(id)) ||
      (record.cases || []).some((item) => item.id && item.caseId && item.id !== item.caseId)) {
    throw new Error('Report cases do not match the selected case IDs')
  }
  const finalized = (record.cases || []).filter((item) => terminalStatuses.has(item.status))
  return {
    selected,
    finalized,
    complete: selected.length > 0 && finalized.length === selected.length
  }
}

export function writeProgress (record, {
  outputRoot = config.outputRoot, caseRecord, phase = 'RUNNING', settings = config, fileSystem = fs
} = {}) {
  const locations = runPaths(record, outputRoot)
  const selection = selectionState(record)
  const entries = caseRecord ? [caseRecord] : record.cases || []
  for (const item of entries) {
    if (!(record.cases || []).includes(item)) throw new Error('Case snapshot is not part of this run')
    const file = path.join(locations.caseDir, `${safeCaseId(item.caseId || item.id)}.json`)
    const snapshot = reportSnapshot(item, { settings })
    atomicWriteFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, { fileSystem })
  }
  const counts = Object.fromEntries([...terminalStatuses, 'RUNNING'].map((status) => [
    status, (record.cases || []).filter((item) => item.status === status).length
  ]))
  const executedCases = selection.finalized.filter((item) => item.status !== 'SKIPPED')
    .map((item) => item.caseId || item.id)
  const finalizedIds = new Set(selection.finalized.map((item) => item.caseId || item.id))
  const finished = phase === 'FINISHED' && selection.complete && !record.runError && Boolean(record.finishedAt)
  const progress = reportSnapshot({
    schemaVersion: 1,
    runId: record.runId,
    startedAt: record.startedAt,
    environment: record.environment,
    updatedAt: new Date().toISOString(),
    phase,
    selectionComplete: selection.complete,
    selectedSuites: record.selectedSuites || [],
    selectedCases: selection.selected,
    executedCases,
    pendingCases: selection.selected.filter((id) => !finalizedIds.has(id)),
    counts: {
      selected: selection.selected.length,
      finalized: selection.finalized.length,
      executed: executedCases.length,
      pending: selection.selected.length - selection.finalized.length,
      ...counts
    },
    results: (record.cases || []).map((item) => ({
      caseId: item.caseId || item.id,
      suite: item.suite,
      status: item.status,
      resultFile: path.join(locations.caseDir, `${safeCaseId(item.caseId || item.id)}.json`)
    })),
    locations,
    ...(record.runError ? { runError: record.runError } : {}),
    ...(finished ? { finishedAt: record.finishedAt, passed: isRunPassed(record) } : {})
  }, { settings })
  atomicWriteFile(locations.progressFile, `${JSON.stringify(progress, null, 2)}\n`, { fileSystem })
  return locations
}

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

export function acceptanceIsComplete ({
  failedChecks = [], remainingAssertions, candidates = [], incomplete = false
} = {}) {
  const noRemaining = remainingAssertions === undefined ||
    (Array.isArray(remainingAssertions) && remainingAssertions.length === 0)
  return !incomplete && failedChecks.length === 0 && noRemaining &&
    candidates.some((candidate) => candidate === true)
}

export function caseOutcome ({ failedChecks, partial, hasAssertions, result } = {}) {
  if (failedChecks?.length) {
    return { status: 'FAIL', note: `失败断言 ${failedChecks.length} 个` }
  }
  if (result?.notImplemented || result?.designed || result?.partial ||
      result?.blocked || result?.skipped) {
    return { status: 'PARTIAL', note: result.note || '步骤尚未实现' }
  }
  if (result?.acceptanceComplete === true) {
    if (!hasAssertions) {
      return { status: 'PARTIAL', note: '完整验收标记缺少有效断言，不能登记通过' }
    }
    return { status: 'PASS', note: '' }
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
  return !record.runError && selectionState(record).complete &&
    record.cases.some((item) => item.status === 'PASS') &&
    record.cases.every((item) =>
      item.status === 'PASS' ||
      (item.status === 'SKIPPED' && item.notes?.includes('断点续跑：此前已通过'))
    )
}

export async function writeReport (record, options = {}) {
  const { outputRoot = config.outputRoot, settings = config, fileSystem = fs } = options
  const { outputDir, resultFile } = runPaths(record, outputRoot)
  if (fileSystem.existsSync(resultFile)) throw new Error(`Final report already exists: ${resultFile}`)
  const complete = selectionState(record).complete && !record.runError
  try {
    for (const directory of [outputDir, path.join(outputDir, 'screenshots'), path.join(outputDir, 'trace')]) {
      fileSystem.mkdirSync(directory, { recursive: true })
    }
  } catch (error) {
    throw new ReportPersistenceError(outputDir, error)
  }
  record.endedAt = new Date().toISOString()
  record.runStatus = complete ? 'COMPLETED' : 'INCOMPLETE'
  if (complete) record.finishedAt = record.endedAt
  else delete record.finishedAt
  record.outputDir = outputDir
  record.passed = isRunPassed(record)

  const snapshot = reportSnapshot(record, { settings })

  const passed = snapshot.cases.filter((item) => item.status === 'PASS').length
  const partial = snapshot.cases.filter((item) => item.status === 'PARTIAL').length
  const failed = snapshot.cases.filter((item) => item.status === 'FAIL').length
  const blocked = snapshot.cases.filter((item) => item.status === 'BLOCKED').length
  const skipped = snapshot.cases.filter((item) => item.status === 'SKIPPED').length
  const lines = [
    `# CFOR E2E 回归报告（${snapshot.runId}）`,
    '',
    `- 环境：${snapshot.environment.target || config.target}`,
    `- 前端：${snapshot.environment.webBase || config.webBase}`,
    `- 后端：${snapshot.environment.apiBase || config.apiUrl}`,
    `- 时间：${snapshot.endedAt}`,
    `- 批次：${complete ? '已完成全部选例' : '未完成全部选例'}`,
    `- 用例：${snapshot.cases.length}，通过 ${passed}，部分 ${partial}，失败 ${failed}，阻塞 ${blocked}，跳过 ${skipped}`,
    '',
    '| 用例 | 套件 | 状态 | 耗时(ms) | 备注 |',
    '|---|---|---|---:|---|'
  ]
  for (const item of snapshot.cases) {
    const note = (item.notes || []).join(' ').replace(/\|/g, '/')
    lines.push(`| ${item.id} | ${item.suite} | ${item.status} | ${item.durationMs || 0} | ${note} |`)
  }
  lines.push('', '## 分层断言明细', '')
  for (const item of snapshot.cases) {
    lines.push(`### ${item.id}（${item.status}）`)
    for (const check of item.checks || []) {
      lines.push(`- [${check.passed ? 'x' : ' '}] ${check.name}${check.details ? `（${check.details}）` : ''}`)
    }
    for (const evidence of item.evidence || []) lines.push(`- 证据：${evidence}`)
    lines.push('')
  }
  if (snapshot.failedApiResponses?.length) {
    lines.push('## API 失败', '')
    for (const failure of snapshot.failedApiResponses) {
      lines.push(`- ${failure.status} ${failure.method} ${failure.url}`)
    }
  }
  atomicWriteFile(path.join(outputDir, 'summary.md'), `${lines.join('\n')}\n`, { fileSystem })
  atomicWriteFile(resultFile, `${JSON.stringify(snapshot, null, 2)}\n`, { fileSystem })
  writeProgress(record, { ...options, phase: complete ? 'FINISHED' : 'STOPPED' })
  return { outputDir, resultFile }
}
