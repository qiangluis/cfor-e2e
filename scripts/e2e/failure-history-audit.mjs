import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const defaultCatalog = path.join(here, 'cases', 'catalog.json')
const environmentKeys = ['target', 'apiBase', 'webBase', 'tenantId', 'dbName']
const statuses = new Set(['PASS', 'PARTIAL', 'FAIL', 'ERROR', 'BLOCKED', 'SKIPPED'])
const failureStatuses = new Set(['FAIL', 'ERROR'])
const successStatuses = new Set(['PASS', 'PARTIAL'])
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0
const normalizeStatus = (value) => typeof value === 'string' ? value.trim().toUpperCase() : ''
const idOf = (value) => value?.caseId || value?.id
const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
const unique = (values) => [...new Set(values)]
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

function canonicalPath(file) {
  const resolved = path.resolve(file)
  try { return fs.realpathSync(resolved) } catch { return resolved }
}

// Strings in notes/details may contain credentials; never emit those strings.
function safeLabel(value) {
  if (!nonempty(value)) return '[unnamed]'
  if (/(?:password|passwd|secret|token|authorization|private.?key)\s*[:=]|bearer\s+\S+|https?:\/\/\S*[?@]|[\w.+-]+@[\w.-]+\.\w+|\b1[3-9]\d{9}\b/i.test(value)) {
    return '[sensitive label omitted]'
  }
  return value.replace(/[\r\n\t]/g, ' ').slice(0, 240)
}

export function discoverAuditFiles({ tmpRoot = '/tmp', roots = [], excludePaths = [] } = {}) {
  const errors = []
  const found = new Set()
  const visited = new Set()
  const excluded = excludePaths.map(canonicalPath)
  const excludedPath = (file) => excluded.some((item) =>
    file === item || file.startsWith(`${item}${path.sep}`))
  const walk = (input) => {
    const file = canonicalPath(input)
    if (visited.has(file) || excludedPath(file)) return
    visited.add(file)
    try {
      const stat = fs.statSync(file)
      if (stat.isFile()) {
        if (['result.json', 'parallel-result.json'].includes(path.basename(file))) found.add(file)
        return
      }
      if (!stat.isDirectory()) return
      for (const entry of fs.readdirSync(file, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isFile()) walk(path.join(file, entry.name))
      }
    } catch {
      errors.push({ sourcePath: file, reason: 'SCAN_UNAVAILABLE' })
    }
  }
  if (roots.length) roots.forEach(walk)
  else {
    try {
      fs.readdirSync(tmpRoot, { withFileTypes: true })
        .filter((entry) => entry.name.startsWith('cfor-e2e') && entry.isDirectory())
        .forEach((entry) => walk(path.join(tmpRoot, entry.name)))
    } catch {
      errors.push({ sourcePath: path.resolve(tmpRoot), reason: 'SCAN_UNAVAILABLE' })
    }
  }
  return { paths: [...found].sort(), errors }
}

function timestamp(value) {
  if (typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null
  const result = Date.parse(value)
  return Number.isFinite(result) ? result : null
}

function timeWindow(run, result, sourceKind) {
  // Run-level timestamps are not per-case execution timestamps.
  const start = timestamp(result.startedAt)
  const end = timestamp(result.finishedAt)
  const issues = []
  if (start === null || end === null) issues.push('CASE_TIME_MISSING_OR_INVALID')
  else if (end < start) issues.push('TIME_REVERSED')
  return {
    start, end, comparable: issues.length === 0, issues,
    source: result.startedAt && result.finishedAt ? 'case' : 'run-window'
  }
}

function environmentOf(run) {
  const environment = run.environment
  const values = {}
  const missing = []
  for (const key of environmentKeys) {
    const value = environment?.[key]
    const valid = nonempty(value) || (key === 'tenantId' && Number.isSafeInteger(value) && value >= 0)
    if (!valid) missing.push(key)
    else values[key] = String(value).trim()
  }
  return { signature: missing.length ? null : hash(values), missing }
}

export function isSpecificAssertion(name) {
  if (!nonempty(name)) return false
  return !/控制台|console|runtime|失败现场|页面异常|浏览器业务.*错误|请求失败|request.*fail|真实登录|登录成功|后端健康|健康检查|health.?check|GET 白名单|GET 请求成功|GET 业务成功|业务响应成功|API 可达|接口可访问|(?:^|\s)无.*错误/i.test(name)
}

function checksOf(result) {
  const groups = new Map()
  const issues = []
  for (const key of ['checks', 'steps']) {
    if (result[key] !== undefined && !Array.isArray(result[key])) {
      issues.push('CHECKS_MALFORMED')
      continue
    }
    for (const [index, check] of (result[key] || []).entries()) {
      if (!object(check) || typeof check.passed !== 'boolean') {
        issues.push('CHECK_RESULT_NOT_BOOLEAN')
        continue
      }
      const name = typeof check.name === 'string' ? check.name : ''
      const layer = typeof check.layer === 'string' ? check.layer : ''
      const signature = hash({ name, layer })
      const entry = groups.get(signature) || {
        name, layer, signature, specific: isSpecificAssertion(name),
        passed: false, failed: false, origins: []
      }
      entry.passed ||= check.passed === true
      entry.failed ||= check.passed === false
      entry.origins.push({ field: key, index })
      groups.set(signature, entry)
    }
  }
  const checks = [...groups.values()]
  if (checks.some((check) => check.failed && check.passed)) issues.push('CHECK_SIGNATURE_CONFLICT')
  return { checks, issues: unique(issues) }
}

function exceptionSummary(result, failedChecks) {
  const names = new Set(failedChecks.filter((check) => check.specific).map((check) => check.name))
  const notes = [
    ...(Array.isArray(result.notes) ? result.notes.filter(nonempty) : []),
    ...(nonempty(result.note) ? [result.note] : [])
  ]
  const unexplained = notes.filter((note) =>
    !/^失败断言 \d+ 个$/.test(note) && !names.has(note))
  const error = nonempty(result.error) ? result.error : null
  if (!error && !unexplained.length && failedChecks.some((check) => check.specific)) return null
  return {
    reason: error || unexplained.length ? 'UNSTRUCTURED_EXCEPTION_OR_NOTES' : 'FAILURE_WITHOUT_SPECIFIC_ASSERTION',
    errorPresent: Boolean(error), noteCount: notes.length,
    unexplainedNoteCount: unexplained.length,
    fingerprint: hash({ error, notes: unexplained }),
    content: '原始异常、notes 和 details 不输出；需人工审计来源文件'
  }
}

function makeExecution(run, result, sourcePath, index, sourceKind) {
  const window = timeWindow(run, result, sourceKind)
  const environment = environmentOf(run)
  const { checks, issues } = checksOf(result)
  const rawStatus = normalizeStatus(result.status)
  const status = statuses.has(rawStatus) ? rawStatus : 'ERROR'
  const runId = safeId(run.runId) ? run.runId : safeId(run.batchId) ? run.batchId : null
  const integrity = [
    ...window.issues, ...issues,
    ...(!runId ? ['RUN_ID_MISSING_OR_INVALID'] : []),
    ...(!statuses.has(rawStatus) ? ['STATUS_MISSING_OR_INVALID'] : []),
    ...(successStatuses.has(status) && checks.some((check) => check.failed)
      ? ['SUCCESS_WITH_FAILED_CHECK'] : [])
  ]
  const failed = checks.filter((check) => check.failed)
  return {
    caseId: idOf(result), status, rawStatusValid: statuses.has(rawStatus),
    runId, sourcePath, index, sourceKind, window, environment, checks,
    integrity: unique(integrity),
    exception: failureStatuses.has(status) ? exceptionSummary(result, failed) : null,
    digest: hash({ runId, environment: run.environment, result }),
    identity: runId && window.comparable
      ? hash({ runId, caseId: idOf(result), start: window.start, end: window.end, environment: environment.signature })
      : null
  }
}

function executionRef(execution) {
  return {
    caseId: execution.caseId, status: execution.status, runId: execution.runId,
    sourcePath: execution.sourcePath, index: execution.index, sourceKind: execution.sourceKind,
    startedAt: execution.window.start === null ? null : new Date(execution.window.start).toISOString(),
    finishedAt: execution.window.end === null ? null : new Date(execution.window.end).toISOString(),
    timeSource: execution.window.source,
    environmentSignature: execution.environment.signature,
    missingEnvironmentFields: execution.environment.missing,
    integrityIssues: execution.integrity
  }
}

function checkRef(check) {
  return {
    name: safeLabel(check.name), layer: safeLabel(check.layer),
    assertionSignature: check.signature, specific: check.specific, origins: check.origins
  }
}

function canReverify(failure, later, check) {
  if (!successStatuses.has(later.status) || !later.rawStatusValid ||
    !failure.window.comparable || !later.window.comparable ||
    failure.integrity.length || later.integrity.length ||
    !failure.environment.signature || failure.environment.signature !== later.environment.signature ||
    later.window.start <= failure.window.end || failure.runId === later.runId) return false
  return later.checks.some((candidate) =>
    candidate.specific && candidate.name === check.name && candidate.layer === check.layer &&
    candidate.signature === check.signature && candidate.passed && !candidate.failed)
}

function failureAudit(execution, executions) {
  const failedChecks = execution.checks.filter((check) => check.failed).map((check) => {
    const matches = check.specific ? executions.filter((later) => canReverify(execution, later, check)) : []
    matches.sort((a, b) => b.window.end - a.window.end || a.sourcePath.localeCompare(b.sourcePath))
    const latest = matches[0] || null
    const tied = latest && matches.some((item) => item !== latest &&
      item.window.end === latest.window.end && item.digest !== latest.digest)
    return {
      ...checkRef(check),
      auditStatus: !check.specific ? 'GENERIC_MANUAL_REVIEW'
        : !latest ? 'UNREVERIFIED'
          : tied ? 'REVERIFICATION_TIME_AMBIGUOUS'
            : latest.status === 'PARTIAL' ? 'REVERIFIED_SUBASSERTION_ONLY' : 'REVERIFIED_ASSERTION',
      lastSuccessfulReverification: latest && !tied ? executionRef(latest) : null,
      caseClosureClaimed: false
    }
  })
  if (execution.exception) failedChecks.push({
    name: '[unstructured exception requires manual audit]',
    assertionSignature: execution.exception.fingerprint,
    specific: false, auditStatus: 'EXCEPTION_MANUAL_REVIEW',
    lastSuccessfulReverification: null, caseClosureClaimed: false,
    exceptionSummary: execution.exception
  })
  return { execution: executionRef(execution), failedChecks }
}

function derivedLatest(executions) {
  const eligible = executions.filter((execution) => execution.status !== 'SKIPPED')
  if (!eligible.length) return { actualStatus: 'UNEXECUTED', ambiguous: false }
  const timed = eligible.filter((execution) => execution.window.comparable)
  timed.sort((a, b) => b.window.end - a.window.end)
  if (!timed.length) return {
    actualStatus: eligible.length === 1 ? eligible[0].status : 'UNDETERMINED', ambiguous: eligible.length > 1
  }
  const latest = timed[0]
  const ties = timed.filter((execution) => execution.window.end === latest.window.end)
  const ambiguous = new Set(ties.map((execution) => execution.status)).size > 1
  return { actualStatus: ambiguous ? 'UNDETERMINED' : latest.status, ambiguous }
}

function acceptance(catalogStatus, actualStatus) {
  if (['DESIGNED', 'BLOCKED'].includes(catalogStatus)) return 'NOT_READY'
  if (catalogStatus === 'PARTIAL' && actualStatus === 'PASS') return 'PARTIAL'
  return actualStatus
}

function readDefinitions(catalogPath) {
  const catalog = readJson(catalogPath)
  if (!Array.isArray(catalog.suites)) throw new Error('Catalog 缺少 suites 数组')
  return catalog.suites.flatMap((suite) => (suite.cases || []).map((definition) => ({
    id: definition.id, suite: suite.id,
    catalogStatus: normalizeStatus(definition.status) || 'READY'
  })))
}

export function buildFailureHistoryAudit({
  coveragePath, catalogPath = defaultCatalog, resultPaths,
  tmpRoot = '/tmp', roots = [], excludePaths = []
} = {}) {
  const coverage = coveragePath ? readJson(coveragePath) : null
  if (coverage && (!Array.isArray(coverage.cases) || !Array.isArray(coverage.scannedResultPaths) ||
    coverage.scannedResultPaths.some((file) => !nonempty(file)))) {
    throw new Error('Coverage 缺少有效 cases/scannedResultPaths 数组')
  }
  const definitions = coverage ? coverage.cases : readDefinitions(catalogPath)
  const knownIds = new Set()
  for (const definition of definitions) {
    if (!safeId(definition.id) || knownIds.has(definition.id)) throw new Error('重复或无效的案例 ID')
    knownIds.add(definition.id)
  }
  const discovered = resultPaths || coverage
    ? { paths: resultPaths || coverage.scannedResultPaths, errors: [] }
    : discoverAuditFiles({ tmpRoot, roots, excludePaths })
  const paths = unique(discovered.paths.map(canonicalPath)).sort()
  const parseErrors = [...discovered.errors]
  const raw = []
  const documents = new Map()
  for (const file of paths) {
    try {
      const run = readJson(file)
      if (!object(run) || (!Array.isArray(run.cases) && !Array.isArray(run.results))) {
        parseErrors.push({ sourcePath: file, reason: 'RESULT_SCHEMA_INVALID' })
        continue
      }
      documents.set(file, run)
    } catch {
      parseErrors.push({ sourcePath: file, reason: 'JSON_UNREADABLE_OR_INVALID', content: '不输出解析异常原文' })
    }
  }
  let linkedBatchRecords = 0
  for (const [file, run] of documents) {
    const sourceKind = Array.isArray(run.cases) ? 'case' : 'parallel-summary'
    const results = sourceKind === 'case' ? run.cases : run.results
    for (const [index, result] of results.entries()) {
      if (!object(result) || !safeId(idOf(result))) {
        parseErrors.push({ sourcePath: file, index, reason: 'CASE_ID_OR_RECORD_INVALID' })
        continue
      }
      // The child report is authoritative; retain wrapper ERRORs (timeouts or
      // launch failures) even when a partial child report was written.
      if (sourceKind === 'parallel-summary' && result.status !== 'ERROR' && nonempty(result.report)) {
        const child = documents.get(canonicalPath(result.report))
        const childCase = child?.cases?.find((item) => idOf(item) === idOf(result))
        if (childCase && normalizeStatus(childCase.status) === normalizeStatus(result.status)) {
          linkedBatchRecords++
          continue
        }
      }
      raw.push(makeExecution(run, result, file, index, sourceKind))
    }
  }
  const executions = []
  const duplicateExecutions = []
  const digests = new Map()
  const identities = new Map()
  for (const execution of raw) {
    if (digests.has(execution.digest)) {
      duplicateExecutions.push({
        duplicate: executionRef(execution), original: executionRef(digests.get(execution.digest))
      })
      continue
    }
    digests.set(execution.digest, execution)
    executions.push(execution)
    if (execution.identity) {
      const peers = identities.get(execution.identity) || []
      peers.push(execution)
      identities.set(execution.identity, peers)
    }
  }
  for (const peers of identities.values()) {
    if (peers.length > 1) for (const execution of peers) execution.integrity.push('EXECUTION_IDENTITY_CONFLICT')
  }
  const byId = new Map()
  for (const execution of executions) {
    const list = byId.get(execution.caseId) || []
    list.push(execution)
    byId.set(execution.caseId, list)
  }
  const coverageParseErrors = (coverage?.parseErrors || []).map((item) => ({
    sourcePath: typeof item.resultPath === 'string' ? item.resultPath : null,
    reason: 'COVERAGE_REPORTED_PARSE_ERROR', content: '不输出原始解析错误'
  }))
  const historyIncomplete = parseErrors.length > 0 || coverageParseErrors.length > 0
  const cases = definitions.map((definition) => {
    const records = byId.get(definition.id) || []
    const history = records.filter((record) => failureStatuses.has(record.status))
      .map((record) => failureAudit(record, records))
    const failedChecks = history.flatMap((failure) =>
      failure.failedChecks.map((check) => ({ ...check, failureExecution: failure.execution })))
    const latest = derivedLatest(records)
    const remaining = failedChecks.filter((check) => check.auditStatus !== 'REVERIFIED_ASSERTION')
    const localIntegrity = records.some((record) => record.integrity.length || record.environment.missing.length)
    return {
      id: definition.id, suite: safeId(definition.suite) ? definition.suite : null,
      catalogStatus: definition.catalogStatus ?? null,
      actualStatus: coverage ? definition.actualStatus : latest.actualStatus,
      acceptanceStatus: coverage ? definition.acceptanceStatus : acceptance(definition.catalogStatus, latest.actualStatus),
      statusSource: coverage ? 'coverage-unchanged' : 'raw-latest-without-mtime',
      latestSelectionAmbiguous: latest.ambiguous,
      auditStatus: history.length
        ? remaining.some((check) => check.auditStatus !== 'REVERIFIED_SUBASSERTION_ONLY')
          ? 'OPEN_HISTORICAL_FAILURE'
          : remaining.length ? 'PARTIAL_SUBASSERTIONS_ONLY' : 'SPECIFIC_ASSERTIONS_REVERIFIED'
        : historyIncomplete || localIntegrity ? 'HISTORY_INCOMPLETE' : 'NO_HISTORICAL_FAILURE_IN_SCOPE',
      caseClosureClaimed: false,
      historicalFailures: history,
      lastSuccessfulReverification: failedChecks.filter((check) => check.lastSuccessfulReverification),
      unverifiedFailureChecks: remaining,
      partialRecords: records.filter((record) => record.status === 'PARTIAL').map(executionRef),
      skippedRecords: records.filter((record) => record.status === 'SKIPPED').map(executionRef)
    }
  })
  const orphanExecutions = executions.filter((execution) => !knownIds.has(execution.caseId))
    .map((execution) => ({
      ...executionRef(execution),
      failure: failureStatuses.has(execution.status) ? failureAudit(execution, []) : null
    }))
  const allFailureChecks = cases.flatMap((item) => item.historicalFailures.flatMap((failure) => failure.failedChecks))
  const count = (predicate) => allFailureChecks.filter(predicate).length
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    scope: {
      mode: coverage ? 'coverage-scanned-paths' : resultPaths || roots.length ? 'explicit-paths' : 'tmp-cfor-e2e-roots',
      coveragePath: coveragePath ? path.resolve(coveragePath) : null,
      catalogPath: coverage ? coverage.catalogPath || null : path.resolve(catalogPath),
      coverageSince: coverage?.since || null,
      coverageSinceAppliedToHistory: false,
      historyIncomplete,
      noCaseClosureClaimed: true,
      policy: '同环境五字段完整、严格后续非重叠时间、同名同层具体断言、PASS/PARTIAL 才记录子项复验；无 mtime 推断'
    },
    scannedResultPaths: paths,
    summary: {
      totalCases: cases.length, executionCount: executions.length,
      historicalFailureExecutions: cases.reduce((sum, item) => sum + item.historicalFailures.length, 0),
      historicalFailureItems: allFailureChecks.length,
      reverifiedByPass: count((check) => check.auditStatus === 'REVERIFIED_ASSERTION'),
      reverifiedByPartial: count((check) => check.auditStatus === 'REVERIFIED_SUBASSERTION_ONLY'),
      unverifiedSpecificChecks: count((check) => check.specific && !check.lastSuccessfulReverification),
      manualExceptionItems: count((check) => check.auditStatus === 'EXCEPTION_MANUAL_REVIEW'),
      genericFailureChecks: count((check) => check.auditStatus === 'GENERIC_MANUAL_REVIEW'),
      openHistoryCases: cases.filter((item) => item.auditStatus === 'OPEN_HISTORICAL_FAILURE').length,
      partialSubassertionCases: cases.filter((item) => item.auditStatus === 'PARTIAL_SUBASSERTIONS_ONLY').length,
      orphanExecutionCount: orphanExecutions.length,
      orphanFailureCount: orphanExecutions.filter((item) => failureStatuses.has(item.status)).length,
      recordsWithoutComparableTime: executions.filter((execution) => !execution.window.comparable).length,
      recordsWithMissingEnvironment: executions.filter((execution) => execution.environment.missing.length).length,
      parseErrorCount: parseErrors.length + coverageParseErrors.length,
      duplicateExecutionCount: duplicateExecutions.length,
      linkedBatchRecordCount: linkedBatchRecords,
      caseClosures: 0
    },
    cases, orphanExecutions,
    recordsWithoutComparableTime: executions.filter((execution) => !execution.window.comparable).map(executionRef),
    integrityIssues: executions.filter((execution) =>
      execution.integrity.length || execution.environment.missing.length).map(executionRef),
    parseErrors: [...parseErrors, ...coverageParseErrors],
    duplicateExecutions
  }
}

const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ')

export function renderAuditMarkdown(report) {
  const lines = [
    '# CFOR 历史失败子断言复验审计', '',
    `- 时间：${report.generatedAt}`,
    `- 范围：${report.scope.mode}；结果文件 ${report.scannedResultPaths.length}`,
    `- 统计：${JSON.stringify(report.summary)}`,
    '- 原 actualStatus/acceptanceStatus 不升级；具体子断言复验不代表案例闭环。PARTIAL、SKIPPED、通用检查不能关闭业务异常。',
    '- notes/error/details 原文不输出；未具名异常须人工审计来源文件。', '',
    '| Case | Actual | Acceptance | 历史失败次数 | 子项 PASS / PARTIAL 复验 | 待复验/人工项 | 审计状态 |',
    '|---|---|---|---:|---:|---:|---|'
  ]
  for (const item of report.cases) {
    lines.push([
      item.id, item.actualStatus, item.acceptanceStatus, item.historicalFailures.length,
      `${item.lastSuccessfulReverification.filter((check) => check.auditStatus === 'REVERIFIED_ASSERTION').length} / ${item.lastSuccessfulReverification.filter((check) => check.auditStatus === 'REVERIFIED_SUBASSERTION_ONLY').length}`,
      item.unverifiedFailureChecks.length, item.auditStatus
    ].map(cell).join(' | '))
  }
  lines.push('', '## 历史失败及最后成功子项复验', '')
  for (const item of report.cases.filter((candidate) => candidate.historicalFailures.length)) {
    lines.push(`### ${cell(item.id)}`)
    for (const failure of item.historicalFailures) {
      lines.push(`- ${cell(failure.execution.status)} ${cell(failure.execution.finishedAt || '时间不确定')}；${cell(failure.execution.sourcePath)}#${failure.execution.index}`)
      for (const check of failure.failedChecks) {
        const later = check.lastSuccessfulReverification
        lines.push(`- ${cell(check.name)}：${check.auditStatus}；${later ? `${later.status} ${later.finishedAt} ${cell(later.sourcePath)}#${later.index}` : '未获得合格复验/需人工审计'}`)
      }
    }
  }
  lines.push('', '## Orphan 执行', '')
  for (const item of report.orphanExecutions) lines.push(`- ${cell(item.caseId)} ${item.status}；${cell(item.sourcePath)}#${item.index}`)
  lines.push('', '## 时间与完整性问题', '')
  for (const item of report.integrityIssues) lines.push(`- ${cell(item.caseId)}；${cell(item.sourcePath)}#${item.index}；${cell(item.integrityIssues.join(','))}；缺环境：${item.missingEnvironmentFields.join(',')}`)
  for (const item of report.parseErrors) lines.push(`- ${cell(item.sourcePath)}；${item.reason}`)
  return `${lines.join('\n')}\n`
}

export function writeAuditOutputs(report, out) {
  if (!nonempty(out)) throw new Error('--out 缺少路径')
  const resolved = path.resolve(out)
  const extension = path.extname(resolved).toLowerCase()
  const stem = ['.json', '.md', '.markdown'].includes(extension)
    ? resolved.slice(0, -extension.length) : resolved
  const outputs = { json: `${stem}.json`, markdown: `${stem}.md` }
  const inputs = new Set([
    ...report.scannedResultPaths, report.scope.coveragePath, report.scope.catalogPath
  ].filter(Boolean).map(canonicalPath))
  for (const file of Object.values(outputs)) {
    if (inputs.has(canonicalPath(file)) || ['result.json', 'parallel-result.json'].includes(path.basename(file))) {
      throw new Error('--out 不得覆盖输入或冒充原始执行结果')
    }
  }
  fs.mkdirSync(path.dirname(stem), { recursive: true })
  fs.writeFileSync(outputs.json, `${JSON.stringify(report, null, 2)}\n`)
  fs.writeFileSync(outputs.markdown, renderAuditMarkdown(report))
  return outputs
}

export function main(argv = process.argv.slice(2)) {
  const options = { roots: [], excludePaths: [] }
  let out
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: node failure-history-audit.mjs [--coverage FILE] [--catalog FILE] [--tmp-root DIR] [--root DIR] [--exclude-root DIR] [--out PREFIX]\n默认扫描 /tmp/cfor-e2e* 下 result.json 与 parallel-result.json；--coverage 只读取 scannedResultPaths，历史不应用 since。\n')
      return null
    }
    if (!['--coverage', '--catalog', '--tmp-root', '--root', '--exclude-root', '--out'].includes(arg)) {
      throw new Error('未知审计参数')
    }
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error('审计参数缺少值')
    if (arg === '--out') out = value
    else if (arg === '--root') options.roots.push(value)
    else if (arg === '--exclude-root') options.excludePaths.push(value)
    else options[{ '--coverage': 'coveragePath', '--catalog': 'catalogPath', '--tmp-root': 'tmpRoot' }[arg]] = value
  }
  if (options.coveragePath && (options.roots.length || options.tmpRoot || options.excludePaths.length)) {
    throw new Error('--coverage 与扫描范围参数不可混用')
  }
  const report = buildFailureHistoryAudit(options)
  const outputs = out ? writeAuditOutputs(report, out) : null
  process.stdout.write(`${JSON.stringify(outputs ? { summary: report.summary, outputs } : report, null, 2)}\n`)
  return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch { process.stderr.write('历史审计失败：请检查参数、输入结构与文件访问；不输出原始异常内容。\n'); process.exitCode = 1 }
}
