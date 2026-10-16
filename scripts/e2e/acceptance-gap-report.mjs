import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCatalog } from './coverage-report.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const defaultCatalogPath = path.join(here, 'cases', 'catalog.json')
const CASE_STATUSES = new Set([
  'PASS', 'PARTIAL', 'FAIL', 'BLOCKED', 'ERROR', 'SKIPPED', 'UNEXECUTED', 'NOT_READY'
])
const VERIFIED_STATUS = 'VERIFIED'

function readJson (filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function normalizeStatus (value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : ''
}

function resolvePath (basePath, value) {
  if (typeof value !== 'string' || !value) return null
  return path.resolve(path.isAbsolute(value) ? value : path.dirname(basePath), value)
}

function unique (items) {
  return [...new Set(items)]
}

function sourceCaseId (item) {
  return item?.caseId || item?.id || null
}

function sourceCaseRecord (sourceDocument, caseId) {
  if (Array.isArray(sourceDocument?.cases)) {
    return sourceDocument.cases.find((item) => sourceCaseId(item) === caseId) || null
  }
  if (sourceCaseId(sourceDocument) === caseId) return sourceDocument
  return null
}

function sourceRunId (sourceDocument) {
  return sourceDocument?.runId || sourceDocument?.batchId || null
}

function safeEnvironment (environment) {
  if (!environment || typeof environment !== 'object') return null
  const allowed = [
    'target', 'tenantId', 'tenantName', 'webBase', 'apiBase', 'apiHealthUrl',
    'dbName', 'profile'
  ]
  return Object.fromEntries(allowed
    .filter((key) => environment[key] !== undefined && environment[key] !== null)
    .map((key) => [key, environment[key]]))
}

function environmentWarnings (environment, sourcePath) {
  if (!environment || typeof environment !== 'object') {
    return [`${sourcePath} 缺少 environment`]
  }
  const required = ['target', 'tenantId', 'webBase', 'apiBase']
  const missing = required.filter((key) => environment[key] === undefined || environment[key] === null || environment[key] === '')
  return missing.length ? [`${sourcePath} environment 缺少 ${missing.join(', ')}`] : []
}

function numericIndex (value) {
  if (Number.isInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return null
}

function assertionMappings (caseRecord) {
  if (!Array.isArray(caseRecord?.catalogAssertions)) return []
  return caseRecord.catalogAssertions
    .filter((item) => item && typeof item === 'object')
    .map((item, position) => ({
      position,
      index: numericIndex(item.index),
      assertion: typeof item.assertion === 'string' ? item.assertion : null,
      status: normalizeStatus(item.status)
    }))
}

function assertionResult (catalogAssertion, index, mappings) {
  const exact = mappings.filter((item) =>
    item.index === index && item.assertion === catalogAssertion)
  const sameIndex = mappings.filter((item) => item.index === index)
  const sameAssertion = mappings.filter((item) => item.assertion === catalogAssertion)

  if (exact.length === 1 && exact[0].status === VERIFIED_STATUS) {
    return {
      index,
      assertion: catalogAssertion,
      status: 'RECORDED_VERIFIED',
      mappingPosition: exact[0].position,
      mappingIssue: null
    }
  }

  if (exact.length > 1) {
    return {
      index,
      assertion: catalogAssertion,
      status: 'GAP',
      mappingPosition: null,
      mappingIssue: 'DUPLICATE_EXACT_MAPPING'
    }
  }

  if (exact.length === 1) {
    return {
      index,
      assertion: catalogAssertion,
      status: 'GAP',
      mappingPosition: exact[0].position,
      mappingIssue: exact[0].status
        ? `EXPLICIT_STATUS_${exact[0].status}`
        : 'MISSING_VERIFIED_STATUS'
    }
  }

  return {
    index,
    assertion: catalogAssertion,
    status: 'NOT_RECORDED',
    mappingPosition: null,
    mappingIssue: sameIndex.length || sameAssertion.length
      ? 'MISMATCHED_OR_EXPIRED_MAPPING'
      : 'NO_STRUCTURED_MAPPING'
  }
}

function acceptanceGateResult (assertion, mappings) {
  const matches = mappings.filter((item) => item.assertion === assertion)
  return {
    assertion,
    status: matches.length === 1 && matches[0].status === VERIFIED_STATUS
      ? 'RECORDED_VERIFIED' : 'GAP',
    mappingIssue: matches.length === 0 ? 'NO_STRUCTURED_MAPPING'
      : matches.length > 1 ? 'DUPLICATE_EXACT_MAPPING'
        : matches[0].status === VERIFIED_STATUS ? null : 'MISSING_VERIFIED_STATUS'
  }
}

function caseAcceptanceStatus (actualStatus, assertions, hasStructuredMapping) {
  if (assertions.length > 0 && assertions.every((item) => item.status === 'RECORDED_VERIFIED')) {
    return 'RECORDED_VERIFIED'
  }
  if (assertions.some((item) => item.status === 'GAP')) return 'GAP'
  if (normalizeStatus(actualStatus) === 'PASS' && !hasStructuredMapping) return 'NEEDS_REVIEW'
  return 'NOT_RECORDED'
}

function sourceEvidencePaths (coverageCase, sourcePath) {
  return unique([
    sourcePath,
    ...(Array.isArray(coverageCase?.evidencePaths) ? coverageCase.evidencePaths : [])
      .filter((item) => typeof item === 'string' && item)
      .map((item) => path.resolve(item))
  ].filter(Boolean))
}

function loadSource (sourcePath, cache) {
  if (!sourcePath) return { document: null, error: 'coverage latest sourcePath 缺失' }
  if (cache.has(sourcePath)) return cache.get(sourcePath)
  try {
    const value = { document: readJson(sourcePath), error: null }
    cache.set(sourcePath, value)
    return value
  } catch (error) {
    const value = {
      document: null,
      error: `${sourcePath} 无法读取 sourcePath：${error instanceof Error ? error.message : String(error)}`
    }
    cache.set(sourcePath, value)
    return value
  }
}

function checksSummary (caseRecord) {
  const recorded = Array.isArray(caseRecord?.checks)
  const checks = recorded ? caseRecord.checks : []
  const passed = checks.filter((item) => item?.passed === true).length
  const failed = checks.filter((item) => item?.passed === false).length
  return { recorded, total: checks.length, passed, failed, unknown: checks.length - passed - failed }
}

function remainingAssertions (caseRecord) {
  if (!Array.isArray(caseRecord?.remainingAssertions)) return null
  return caseRecord.remainingAssertions.map((item) => {
    const assertion = typeof item === 'string' ? item : item?.assertion
    return typeof assertion === 'string' && assertion.trim() ? assertion : null
  })
}

function buildCaseReport (definition, coverageCase, sourceCache, warnings) {
  const execution = coverageCase?.latestExecution || null
  const sourcePath = typeof execution?.sourcePath === 'string' ? path.resolve(execution.sourcePath) : null
  const loaded = loadSource(sourcePath, sourceCache)
  if (loaded.error) warnings.push(loaded.error)

  const sourceRecord = sourceCaseRecord(loaded.document, definition.id)
  const catalogAssertions = Array.isArray(definition.declared?.assertions)
    ? definition.declared.assertions
    : []
  const mappings = assertionMappings(sourceRecord)
  const assertions = catalogAssertions.map((assertion, index) =>
    assertionResult(assertion, index, mappings))
  const acceptanceGates = (definition.declared?.acceptanceGaps || []).map((assertion) =>
    acceptanceGateResult(assertion, mappings))
  const hasStructuredMapping = mappings.length > 0
  const actualStatus = normalizeStatus(coverageCase?.actualStatus) || 'UNEXECUTED'
  if (!CASE_STATUSES.has(actualStatus)) warnings.push(`${definition.id} coverage status 未知：${actualStatus}`)
  if (sourcePath && !sourceRecord && loaded.document) {
    warnings.push(`${sourcePath} 未找到 ${definition.id} 原 caseRecord`)
  }

  const runId = execution?.runId || sourceRunId(loaded.document)
  if (!runId) warnings.push(`${definition.id} 缺少 runId`)
  warnings.push(...environmentWarnings(loaded.document?.environment, sourcePath || definition.id))

  const completionBlockers = []
  if (actualStatus !== 'PASS' || coverageCase?.executed !== true) completionBlockers.push('EXECUTION_NOT_PASS')
  if (normalizeStatus(sourceRecord?.status) !== 'PASS') completionBlockers.push('SOURCE_NOT_PASS')
  if (sourceRecord?.partial === true || sourceRecord?.passCandidate === false ||
      sourceRecord?.acceptanceComplete === false) completionBlockers.push('EXPLICIT_INCOMPLETE')
  if (!assertions.length || assertions.some((item) => item.status !== 'RECORDED_VERIFIED')) {
    completionBlockers.push('ASSERTION_GAP')
  }
  if (acceptanceGates.some((item) => item.status !== 'RECORDED_VERIFIED') ||
      sourceRecord?.remainingAssertions?.length) completionBlockers.push('ACCEPTANCE_GATE_GAP')
  if (!Array.isArray(sourceRecord?.checks) || !sourceRecord.checks.length ||
      sourceRecord.checks.some((item) => item.passed !== true)) completionBlockers.push('INCOMPLETE_CHECK')
  if (['console', 'page', 'api', 'request', 'nodeApi'].some((key) =>
    !Array.isArray(sourceRecord?.runtimeErrors?.[key]))) {
    completionBlockers.push('INCOMPLETE_RUNTIME_EVIDENCE')
  }
  if (sourceRecord?.runtimeErrors && Object.values(sourceRecord.runtimeErrors).some((items) =>
    !Array.isArray(items) || items.length > 0)) completionBlockers.push('RUNTIME_FAILURE')
  const recordedStatus = caseAcceptanceStatus(actualStatus, assertions, hasStructuredMapping)
  return {
    id: definition.id,
    suite: definition.suite,
    title: definition.title,
    catalogStatus: definition.catalogStatus,
    actualStatus,
    acceptanceStatus: recordedStatus === 'RECORDED_VERIFIED' && completionBlockers.length
      ? 'GAP' : recordedStatus,
    completeAcceptance: completionBlockers.length === 0,
    completionBlockers,
    executed: Boolean(coverageCase?.executed),
    runId: runId || null,
    environment: safeEnvironment(loaded.document?.environment),
    sourcePath,
    evidencePaths: sourceEvidencePaths(coverageCase, sourcePath),
    skippedRecordCount: Number(coverageCase?.skippedRecordCount || 0),
    checksSummary: checksSummary(sourceRecord),
    remainingAssertions: remainingAssertions(sourceRecord),
    assertions,
    acceptanceGates
  }
}

function countBy (items, key) {
  return items.reduce((counts, item) => {
    const value = item[key] || 'UNKNOWN'
    counts[value] = (counts[value] || 0) + 1
    return counts
  }, {})
}

function sumChecks (items) {
  return Object.fromEntries(['total', 'passed', 'failed', 'unknown'].map((key) => [
    key, items.reduce((total, item) => total + item.checksSummary[key], 0)
  ]))
}

export function buildAcceptanceGapReport ({ coveragePath, catalogPath = defaultCatalogPath } = {}) {
  if (!coveragePath) throw new Error('--coverage 缺少参数')
  const resolvedCoveragePath = path.resolve(coveragePath)
  const coverage = readJson(resolvedCoveragePath)
  const { cases: catalogCases } = readCatalog(catalogPath)
  const sourceCache = new Map()
  const warnings = []
  const cases = catalogCases.map((definition) => buildCaseReport(
    definition,
    (coverage.cases || []).find((item) => item.id === definition.id),
    sourceCache,
    warnings
  ))
  const suites = [...new Set(cases.map((item) => item.suite))].map((suite) => {
    const items = cases.filter((item) => item.suite === suite)
    return {
      suite,
      totalCases: items.length,
      completeCases: items.filter((item) => item.completeAcceptance).length,
      nonCompleteCases: items.filter((item) => !item.completeAcceptance).length,
      checksSummary: sumChecks(items),
      actualStatusCounts: countBy(items, 'actualStatus'),
      acceptanceStatusCounts: countBy(items, 'acceptanceStatus'),
      assertionStatusCounts: countBy(items.flatMap((item) => item.assertions), 'status')
    }
  })

  const uniqueWarnings = unique(warnings)
  return {
    generatedAt: new Date().toISOString(),
    coveragePath: resolvedCoveragePath,
    catalogPath: path.resolve(catalogPath),
    ...(coverage.environmentFilter ? { environmentFilter: coverage.environmentFilter } : {}),
    sourcePolicy: '仅读取 coverage 最新 sourcePath；原断言须 exact index + assertion + VERIFIED；完整验收还须实际与原记录 PASS、附加门禁已验证且无未完成检查或运行异常',
    metadataWarnings: uniqueWarnings,
    summary: {
      totalCases: cases.length,
      completeCases: cases.filter((item) => item.completeAcceptance).length,
      nonCompleteCases: cases.filter((item) => !item.completeAcceptance).length,
      checksSummary: sumChecks(cases),
      actualStatusCounts: countBy(cases, 'actualStatus'),
      acceptanceStatusCounts: countBy(cases, 'acceptanceStatus'),
      assertionStatusCounts: countBy(cases.flatMap((item) => item.assertions), 'status'),
      metadataWarningCount: uniqueWarnings.length
    },
    suites,
    cases
  }
}

function markdownCell (value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function caseEvidence (item) {
  return item.evidencePaths.length ? item.evidencePaths.join('<br>') : '无'
}

function checksText (summary) {
  if (summary.recorded === false) return '未记录'
  return `通过 ${summary.passed} / 失败 ${summary.failed} / 未确认 ${summary.unknown}（共 ${summary.total}）`
}

function remainingAssertionsText (items) {
  if (items === null) return '未记录'
  return items.length ? items.map((item) => item ?? '未记录有效断言文本').join('<br>') : '无'
}

export function renderAcceptanceGapMarkdown (report) {
  const lines = [
    '# CFOR E2E 验收缺口报告',
    '',
    '> 本报告汇总已存档执行证据，不代表当前服务健康或最新发布包已复验；运行环境门禁单独见正式执行清单。',
    '',
    `- Coverage：${report.coveragePath}`,
    `- Catalog：${report.catalogPath}`,
    ...(report.environmentFilter ? [`- 精确环境范围：${JSON.stringify(report.environmentFilter)}`] : []),
    `- 案例：${report.summary.totalCases}；完整验收 ${report.summary.completeCases}；非完整 ${report.summary.nonCompleteCases}`,
    `- 已记录 checks：${checksText(report.summary.checksSummary)}`,
    `- 实际状态：${JSON.stringify(report.summary.actualStatusCounts)}`,
    `- 验收状态：${JSON.stringify(report.summary.acceptanceStatusCounts)}`,
    `- 原断言状态：${JSON.stringify(report.summary.assertionStatusCounts)}`,
    '',
    '## Suite 汇总',
    '',
    '| Suite | 案例 | 完整 | 非完整 | Checks | 实际状态 | 验收状态 | 原断言状态 |',
    '|---|---:|---:|---:|---|---|---|---|'
  ]
  for (const suite of report.suites) {
    lines.push([
      suite.suite,
      suite.totalCases,
      suite.completeCases,
      suite.nonCompleteCases,
      checksText(suite.checksSummary),
      JSON.stringify(suite.actualStatusCounts),
      JSON.stringify(suite.acceptanceStatusCounts),
      JSON.stringify(suite.assertionStatusCounts)
    ].map(markdownCell).join(' | '))
  }

  lines.push('', '## 全部案例状态与证据', '',
    '| Case | Suite | 实际状态 | 验收状态 | 已执行 | Checks | 剩余断言（remainingAssertions） | Source | 证据路径 |',
    '|---|---|---|---|---|---|---|---|---|')
  for (const item of report.cases) {
    lines.push([
      item.id, item.suite, item.actualStatus, item.acceptanceStatus,
      item.executed ? '是' : '否', checksText(item.checksSummary),
      remainingAssertionsText(item.remainingAssertions), item.sourcePath || '无', caseEvidence(item)
    ].map(markdownCell).join(' | '))
  }

  lines.push('', '## 全部非完整验收案例与原断言缺口', '')
  for (const item of report.cases.filter((candidate) => !candidate.completeAcceptance)) {
    lines.push(`### ${item.id} ${item.title}`)
    lines.push(`- Suite：${item.suite}`)
    lines.push(`- 实际状态：${item.actualStatus}；验收状态：${item.acceptanceStatus}；已执行：${item.executed ? '是' : '否'}`)
    lines.push(`- Source：${item.sourcePath || '无'}；证据：${caseEvidence(item)}`)
    lines.push(`- 完整验收阻断：${item.completionBlockers.join(', ')}`)
    lines.push(`- 已记录 checks：${checksText(item.checksSummary)}`)
    lines.push(`- 剩余断言（remainingAssertions）：${markdownCell(remainingAssertionsText(item.remainingAssertions))}`)
    if (item.assertions.length === 0) {
      lines.push('- 原catalog无 assertions，未形成可核验的验收映射')
    } else {
      lines.push('- 原断言：')
      for (const assertion of item.assertions) {
        lines.push(`  - [${assertion.status}] #${assertion.index} ${assertion.assertion} (${assertion.mappingIssue})`)
      }
    }
    for (const gate of item.acceptanceGates) {
      lines.push(`- 附加门禁：[${gate.status}] ${gate.assertion} (${gate.mappingIssue})`)
    }
    lines.push('')
  }

  if (report.metadataWarnings.length) {
    lines.push('## 元数据提示', '')
    for (const warning of report.metadataWarnings) lines.push(`- ${warning}`)
    lines.push('')
  }
  lines.push('说明：本报告不根据 HTTP 结果、检查名、notes、error 或 details 推断验收；输出仅保留白名单字段。')
  return `${lines.join('\n')}\n`
}

function outputPaths (out) {
  if (!out) throw new Error('--out 缺少参数')
  const resolved = path.resolve(out)
  const extension = path.extname(resolved).toLowerCase()
  if (extension === '.json') return { json: resolved, markdown: `${resolved.slice(0, -5)}.md` }
  if (extension === '.md' || extension === '.markdown') {
    return { json: `${resolved.slice(0, -extension.length)}.json`, markdown: resolved }
  }
  return { json: `${resolved}.json`, markdown: `${resolved}.md` }
}

export function writeAcceptanceGapReport (report, out, coveragePath) {
  const paths = outputPaths(out)
  const forbidden = new Set([
    path.resolve(coveragePath),
    ...report.cases.map((item) => item.sourcePath).filter(Boolean)
  ])
  if (forbidden.has(paths.json) || forbidden.has(paths.markdown)) {
    throw new Error('拒绝覆盖 coverage 或最新 sourcePath 输入文件')
  }
  fs.mkdirSync(path.dirname(paths.json), { recursive: true })
  fs.writeFileSync(paths.json, `${JSON.stringify(report, null, 2)}\n`)
  fs.writeFileSync(paths.markdown, renderAcceptanceGapMarkdown(report))
  return paths
}

function parseArgs (argv) {
  const args = { coveragePath: null, catalogPath: defaultCatalogPath, out: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--coverage') args.coveragePath = argv[++index]
    else if (arg === '--catalog') args.catalogPath = argv[++index]
    else if (arg === '--out') args.out = argv[++index]
    else if (arg === '--help' || arg === '-h') return { help: true }
    else throw new Error(`未知参数：${arg}`)
  }
  if (!args.coveragePath) throw new Error('--coverage 缺少参数')
  if (!args.out) throw new Error('--out 缺少参数')
  return args
}

export function main (argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    console.log('Usage: node scripts/e2e/acceptance-gap-report.mjs --coverage FILE --out PREFIX [--catalog FILE]')
    return null
  }
  const report = buildAcceptanceGapReport(args)
  return writeAcceptanceGapReport(report, args.out, args.coveragePath)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
