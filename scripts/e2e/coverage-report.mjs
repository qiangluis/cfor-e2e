import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const defaultCatalogPath = path.join(here, 'cases', 'catalog.json')
const defaultTmpRoot = '/tmp'
const actualStatuses = new Set(['PASS', 'PARTIAL', 'FAIL', 'BLOCKED', 'ERROR'])
const catalogOnlyStatuses = new Set(['DESIGNED', 'BLOCKED'])
const resultFileNames = new Set(['result.json', 'parallel-result.json'])

export const ACTUAL_STATUSES = [...actualStatuses]
export const UNEXECUTED_STATUS = 'UNEXECUTED'

function unique (items) {
  return [...new Set(items)]
}

function normalizeStatus (value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : ''
}

function parseTimestamp (value) {
  if (value === undefined || value === null || value === '') return null
  const timestamp = Date.parse(String(value))
  return Number.isFinite(timestamp) ? timestamp : null
}

function latestTimestamp (...values) {
  const timestamps = values.map(parseTimestamp).filter((value) => value !== null)
  return timestamps.length ? Math.max(...timestamps) : null
}

function displayTimestamp (timestamp) {
  return timestamp === null ? null : new Date(timestamp).toISOString()
}

function readJson (filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function canonicalPath (filePath) {
  const resolved = path.resolve(filePath)
  try {
    return fs.realpathSync(resolved)
  } catch {
    return resolved
  }
}

function resolveEvidencePath (sourcePath, value) {
  if (typeof value !== 'string' || !value) return null
  return path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(path.dirname(sourcePath), value)
}

function walkResultFiles (root) {
  if (!fs.existsSync(root)) return []
  const stat = fs.statSync(root)
  if (stat.isFile()) return resultFileNames.has(path.basename(root)) ? [root] : []
  if (!stat.isDirectory()) return []

  const result = []
  const entries = fs.readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) result.push(...walkResultFiles(entryPath))
    else if (entry.isFile() && resultFileNames.has(entry.name)) result.push(entryPath)
  }
  return result
}

export function findResultFiles ({
  roots = [],
  tmpRoot = defaultTmpRoot,
  excludePaths = []
} = {}) {
  const scanRoots = roots.length
    ? roots
    : fs.existsSync(tmpRoot)
      ? fs.readdirSync(tmpRoot, { withFileTypes: true })
          .filter((entry) => entry.name.startsWith('cfor-e2e'))
          .map((entry) => path.join(tmpRoot, entry.name))
      : []
  const excluded = new Set(excludePaths.map((item) => path.resolve(item)))
  const isExcluded = (filePath) => [...excluded].some((excludedPath) =>
    filePath === excludedPath || filePath.startsWith(`${excludedPath}${path.sep}`))
  return unique(scanRoots.flatMap((root) => walkResultFiles(root))
    .map((filePath) => path.resolve(filePath))
    .filter((filePath) => !isExcluded(filePath)))
    .sort()
}

export function readCatalog (catalogPath = defaultCatalogPath) {
  const catalog = readJson(catalogPath)
  const cases = []
  for (const suite of catalog.suites || []) {
    for (const definition of suite.cases || []) {
      cases.push({
        id: definition.id,
        suite: suite.id,
        title: definition.title || definition.id,
        catalogStatus: normalizeStatus(definition.status) || 'READY',
        preconditions: definition.preconditions || [],
        routes: definition.routes || [],
        declared: definition
      })
    }
  }
  return { catalog, cases }
}

function caseStatus (caseResult) {
  const normalized = normalizeStatus(caseResult?.status)
  if (actualStatuses.has(normalized)) return normalized
  if (normalized === 'SKIPPED') return 'SKIPPED'
  return 'ERROR'
}

function caseIdOf (caseResult) {
  return caseResult?.caseId || caseResult?.id || null
}

function executionTime (run, caseResult) {
  const caseTimestamp = latestTimestamp(caseResult?.finishedAt, caseResult?.startedAt)
  if (caseTimestamp !== null) return caseTimestamp
  return latestTimestamp(run?.finishedAt, run?.startedAt)
}

function evidenceFor (sourcePath, run, caseResult, sourceKind) {
  const evidence = Array.isArray(caseResult?.evidence) ? caseResult.evidence : []
  const outputDir = typeof run?.outputDir === 'string'
    ? run.outputDir
    : sourceKind === 'parallel-summary' ? path.dirname(sourcePath) : null
  return {
    resultPath: sourcePath,
    outputDir,
    evidence,
    evidencePaths: unique([
      sourcePath,
      ...(outputDir ? [outputDir] : []),
      ...[caseResult?.report, caseResult?.logFile]
        .map((item) => resolveEvidencePath(sourcePath, item))
        .filter(Boolean),
      ...evidence.filter((item) => typeof item === 'string' && path.isAbsolute(item))
    ])
  }
}

function candidateFrom (sourcePath, run, caseResult, fileMtimeMs, index, sourceKind) {
  const status = caseStatus(caseResult)
  const effectiveTimestamp = executionTime(run, caseResult)
  const evidence = evidenceFor(sourcePath, run, caseResult, sourceKind)
  const parallel = sourceKind === 'parallel-summary'
  const caseTimed = latestTimestamp(caseResult?.finishedAt, caseResult?.startedAt) !== null
  return {
    caseId: caseIdOf(caseResult),
    status,
    effectiveTimestamp,
    effectiveAt: displayTimestamp(effectiveTimestamp),
    startedAt: caseResult?.startedAt || (parallel ? null : run?.startedAt) || null,
    finishedAt: caseResult?.finishedAt || (parallel ? null : run?.finishedAt) || null,
    timestampSource: caseTimed ? 'case' : parallel ? 'batch-window' : 'run-window',
    batchStartedAt: parallel ? run?.startedAt || null : null,
    batchFinishedAt: parallel ? run?.finishedAt || null : null,
    batchId: run?.batchId || null,
    runId: run?.runId || run?.batchId || null,
    sourceKind,
    sourcePath,
    fileMtimeMs,
    index,
    evidence: evidence.evidence,
    evidencePaths: evidence.evidencePaths,
    logFile: caseResult?.logFile || null,
    report: caseResult?.report || null,
    notes: Array.isArray(caseResult?.notes) ? caseResult.notes
      : parallel ? [caseResult?.note, caseResult?.error].filter(Boolean) : []
  }
}

function compareCandidates (left, right) {
  const leftTimestamp = left.effectiveTimestamp === null ? -1 : left.effectiveTimestamp
  const rightTimestamp = right.effectiveTimestamp === null ? -1 : right.effectiveTimestamp
  if (leftTimestamp !== rightTimestamp) return rightTimestamp - leftTimestamp
  if (left.fileMtimeMs !== right.fileMtimeMs) return right.fileMtimeMs - left.fileMtimeMs
  if (left.sourcePath !== right.sourcePath) return right.sourcePath.localeCompare(left.sourcePath)
  return right.index - left.index
}

function isAfterSince (candidate, sinceTimestamp) {
  return sinceTimestamp === null ||
    (candidate.effectiveTimestamp !== null && candidate.effectiveTimestamp >= sinceTimestamp)
}

function acceptanceStatus (catalogStatus, actualStatus) {
  if (catalogOnlyStatuses.has(catalogStatus)) return 'NOT_READY'
  if (catalogStatus === 'PARTIAL' && actualStatus === 'PASS') return 'PARTIAL'
  return actualStatus
}

function emptyExecution () {
  return {
    status: UNEXECUTED_STATUS,
    effectiveAt: null,
    startedAt: null,
    finishedAt: null,
    runId: null,
    sourcePath: null,
    evidence: [],
    evidencePaths: [],
    notes: []
  }
}

function createCaseReport (definition, candidates, skippedCandidates) {
  const executableCandidates = candidates.filter((candidate) => candidate.status !== 'SKIPPED')
  const latest = executableCandidates.sort(compareCandidates)[0] || null
  const execution = latest || emptyExecution()
  const skipped = skippedCandidates.sort(compareCandidates)
  return {
    id: definition.id,
    suite: definition.suite,
    title: definition.title,
    catalogStatus: definition.catalogStatus,
    actualStatus: execution.status,
    acceptanceStatus: acceptanceStatus(definition.catalogStatus, execution.status),
    executed: Boolean(latest),
    skippedRecordCount: skipped.length,
    latestExecution: execution,
    evidencePaths: execution.evidencePaths,
    skippedEvidencePaths: unique(skipped.flatMap((item) => item.evidencePaths))
  }
}

function emptyCounts () {
  return Object.fromEntries([
    'PASS', 'PARTIAL', 'FAIL', 'BLOCKED', 'ERROR', UNEXECUTED_STATUS, 'NOT_READY'
  ].map((status) => [status, 0]))
}

function increment (counts, status) {
  counts[status] = (counts[status] || 0) + 1
}

export function buildCoverageReport ({
  catalogPath = defaultCatalogPath,
  resultPaths,
  roots = [],
  tmpRoot = defaultTmpRoot,
  since = null,
  excludePaths = []
} = {}) {
  const { catalog, cases: catalogCases } = readCatalog(catalogPath)
  const sinceTimestamp = since === null || since === undefined ? null : parseTimestamp(since)
  if (since !== null && since !== undefined && sinceTimestamp === null) {
    throw new Error(`无效 --since 时间：${since}`)
  }

  const paths = unique((resultPaths || findResultFiles({ roots, tmpRoot, excludePaths }))
    .map((filePath) => path.resolve(filePath)))
  const candidatesByCase = new Map()
  const skippedByCase = new Map()
  const parseErrors = []
  const orphanExecutions = []
  const documents = new Map()
  const documentsByCanonicalPath = new Map()

  for (const sourcePath of paths) {
    let run
    try {
      run = readJson(sourcePath)
    } catch (error) {
      parseErrors.push({
        resultPath: sourcePath,
        error: error instanceof Error ? error.message : String(error)
      })
      continue
    }
    let fileMtimeMs = 0
    try {
      fileMtimeMs = fs.statSync(sourcePath).mtimeMs
    } catch {
      // The file may disappear between discovery and reading.
    }

    const document = { run, fileMtimeMs }
    documents.set(sourcePath, document)
    documentsByCanonicalPath.set(canonicalPath(sourcePath), document)
  }

  const overriddenChildren = new Set()
  const wrapperChildren = new Map()
  for (const [sourcePath, { run }] of documents) {
    if (Array.isArray(run?.cases) || !Array.isArray(run?.results)) continue
    for (const result of run.results) {
      if (typeof result?.report !== 'string' || !result.report) continue
      const childPath = resolveEvidencePath(sourcePath, result.report)
      const childDocument = childPath
        ? documentsByCanonicalPath.get(canonicalPath(childPath))
        : null
      const childCase = childDocument?.run?.cases
        ?.find((item) => caseIdOf(item) === caseIdOf(result))
      if (!childCase) continue
      wrapperChildren.set(result, childCase)
      // An abnormal worker exit invalidates its own child report, not later reruns.
      if (caseStatus(result) === 'ERROR') {
        overriddenChildren.add(`${canonicalPath(childPath)}\0${caseIdOf(result)}`)
      }
    }
  }

  for (const [sourcePath, { run, fileMtimeMs }] of documents) {
    const sourceKind = Array.isArray(run?.cases) ? 'case' : 'parallel-summary'
    const results = sourceKind === 'case' ? run.cases : run?.results
    if (!Array.isArray(results)) continue
    results.forEach((caseResult, index) => {
      if (sourceKind === 'case' &&
        overriddenChildren.has(`${canonicalPath(sourcePath)}\0${caseIdOf(caseResult)}`)) return
      const childCase = wrapperChildren.get(caseResult)
      if (sourceKind === 'parallel-summary' && childCase &&
        caseStatus(caseResult) !== 'ERROR' &&
        caseStatus(caseResult) === caseStatus(childCase)) return
      const candidate = candidateFrom(
        sourcePath, run, caseResult, fileMtimeMs, index, sourceKind
      )
      if (!candidate.caseId) {
        parseErrors.push({ resultPath: sourcePath, error: `case[${index}] 缺少 id/caseId` })
        return
      }
      if (!isAfterSince(candidate, sinceTimestamp)) return

      const known = catalogCases.some((definition) => definition.id === candidate.caseId)
      if (!known) {
        orphanExecutions.push(candidate)
        return
      }
      const target = candidate.status === 'SKIPPED' ? skippedByCase : candidatesByCase
      const list = target.get(candidate.caseId) || []
      list.push(candidate)
      target.set(candidate.caseId, list)
    })
  }

  const cases = catalogCases.map((definition) => createCaseReport(
    definition,
    candidatesByCase.get(definition.id) || [],
    skippedByCase.get(definition.id) || []
  ))
  const actualCounts = emptyCounts()
  const catalogCounts = {}
  const acceptanceCounts = emptyCounts()
  for (const item of cases) {
    increment(actualCounts, item.actualStatus)
    increment(acceptanceCounts, item.acceptanceStatus)
    increment(catalogCounts, item.catalogStatus)
  }

  return {
    generatedAt: new Date().toISOString(),
    catalogPath: path.resolve(catalogPath),
    scannedResultPaths: paths,
    since: sinceTimestamp === null ? null : displayTimestamp(sinceTimestamp),
    summary: {
      totalCases: cases.length,
      executedCases: cases.filter((item) => item.executed).length,
      unexecutedCases: cases.filter((item) => !item.executed).length,
      catalogStatusCounts: catalogCounts,
      actualStatusCounts: actualCounts,
      acceptanceStatusCounts: acceptanceCounts,
      parseErrorCount: parseErrors.length,
      orphanExecutionCount: orphanExecutions.length
    },
    cases,
    orphanExecutions,
    parseErrors
  }
}

function markdownCell (value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

export function renderMarkdown (report) {
  const lines = [
    '# CFOR E2E 执行覆盖盘点',
    '',
    `- 生成时间：${report.generatedAt}`,
    `- Catalog：${report.catalogPath}`,
    `- 扫描结果文件：${report.scannedResultPaths.length}`,
    `- since：${report.since || '未设置'}`,
    `- 用例：${report.summary.totalCases}，已执行 ${report.summary.executedCases}，未执行 ${report.summary.unexecutedCases}`,
    `- 实际状态：${JSON.stringify(report.summary.actualStatusCounts)}`,
    `- Catalog 状态：${JSON.stringify(report.summary.catalogStatusCounts)}`,
    '',
    '| Case | Suite | Catalog实现状态 | 实际执行状态 | 验收状态 | 证据 |',
    '|---|---|---|---|---|---|'
  ]
  for (const item of report.cases) {
    const evidence = item.evidencePaths.length
      ? item.evidencePaths.join('<br>')
      : item.skippedEvidencePaths.length
        ? `仅 SKIPPED：${item.skippedEvidencePaths.join('<br>')}`
        : '无'
    lines.push([
      item.id,
      item.suite,
      item.catalogStatus,
      item.actualStatus,
      item.acceptanceStatus,
      evidence
    ].map(markdownCell).join(' | '))
  }

  if (report.orphanExecutions.length) {
    lines.push('', '## Catalog 外执行记录', '')
    for (const item of report.orphanExecutions) {
      lines.push(`- ${item.caseId}：${item.status}；${item.sourcePath}`)
    }
  }
  if (report.parseErrors.length) {
    lines.push('', '## 结果文件解析问题', '')
    for (const item of report.parseErrors) lines.push(`- ${item.resultPath}：${item.error}`)
  }
  lines.push('', '说明：同时扫描 result.json 与 parallel-result.json；并行 ERROR 不被关联子报告掩盖。缺少案例时间的并行记录只用批次窗口排序，不冒充精确案例时间。SKIPPED 不替代实际执行；无执行记录不会升级为 PASS；DESIGNED/BLOCKED 的 Catalog 状态不会被实际结果提升为可验收 PASS。')
  return `${lines.join('\n')}\n`
}

function parseArgs (argv) {
  const args = {
    catalogPath: defaultCatalogPath,
    tmpRoot: defaultTmpRoot,
    roots: [],
    excludePaths: [],
    out: null,
    since: null,
    format: 'both'
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--catalog') args.catalogPath = argv[++index]
    else if (arg === '--tmp-root') args.tmpRoot = argv[++index]
    else if (arg === '--root') {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new Error('--root 缺少参数')
      args.roots.push(value)
    } else if (arg === '--exclude-root') {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new Error('--exclude-root 缺少参数')
      args.excludePaths.push(value)
    }
    else if (arg === '--out') args.out = argv[++index]
    else if (arg === '--since') args.since = argv[++index]
    else if (arg === '--format') args.format = argv[++index]
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  if (!['json', 'markdown', 'both'].includes(args.format)) {
    throw new Error(`--format 必须是 json、markdown 或 both：${args.format}`)
  }
  if (args.help) return args
  for (const name of ['catalogPath', 'tmpRoot']) {
    if (!args[name]) throw new Error(`${name} 缺少参数`)
  }
  return args
}

function outputPaths (out) {
  if (!out) return null
  const extension = path.extname(out).toLowerCase()
  if (extension === '.json') return { json: out, markdown: `${out.slice(0, -5)}.md` }
  if (extension === '.md' || extension === '.markdown') {
    return { json: `${out.slice(0, -extension.length)}.json`, markdown: out }
  }
  return { json: `${out}.json`, markdown: `${out}.md` }
}

export function resolvedOutputPaths (out) {
  const paths = outputPaths(out)
  return paths
    ? {
        json: path.resolve(paths.json),
        markdown: path.resolve(paths.markdown)
      }
    : null
}

export function writeReportOutputs (report, out, format = 'both') {
  const json = `${JSON.stringify(report, null, 2)}\n`
  const markdown = renderMarkdown(report)
  const paths = resolvedOutputPaths(out)
  if (!paths) {
    if (format === 'json') process.stdout.write(json)
    else if (format === 'markdown') process.stdout.write(markdown)
    else process.stdout.write(json)
    return null
  }

  fs.mkdirSync(path.dirname(path.resolve(paths.json)), { recursive: true })
  if (format === 'json' || format === 'both') fs.writeFileSync(paths.json, json)
  if (format === 'markdown' || format === 'both') fs.writeFileSync(paths.markdown, markdown)
  return paths
}

function printHelp () {
  process.stdout.write([
    'Usage: node scripts/e2e/coverage-report.mjs [options]',
    '',
    '  --catalog PATH       catalog.json path',
    '  --tmp-root PATH      parent directory containing cfor-e2e* outputs',
    '  --root PATH          scan only this evidence root (repeatable)',
    '  --exclude-root PATH  exclude this file or evidence tree (repeatable)',
    '  --since ISO          only include executions at or after ISO timestamp',
    '  --out PATH           write PATH.json and PATH.md (extension may be supplied)',
    '  --format FORMAT      json, markdown, or both (default: json on stdout, both with --out)',
    '  --help               show this help'
  ].join('\n') + '\n')
}

export async function main (argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    printHelp()
    return null
  }
  const format = args.out ? args.format : args.format === 'both' ? 'json' : args.format
  const output = resolvedOutputPaths(args.out)
  const report = buildCoverageReport({
    ...args,
    excludePaths: unique([
      ...(args.excludePaths || []),
      ...(output ? [output.json] : [])
    ])
  })
  return writeReportOutputs(report, args.out, format)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
