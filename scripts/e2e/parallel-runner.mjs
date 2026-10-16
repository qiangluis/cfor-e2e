#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { config } from './config/index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const catalog = JSON.parse(
  fs.readFileSync(path.join(here, 'cases/catalog.json'), 'utf8')
)

// Keep parallel execution limited to cases that do not share mutable business facts.
export const parallelSafeCases = new Set([
  'SMOKE-001',
  'SMOKE-002',
  'WBF-001',
  'WBF-002',
  'WBF-003',
  'WBF-004',
  'WBF-005',
  'WBF-006',
  'WBF-008',
  'WBF-009',
  'WBF-012',
  'PROC-009',
  'PROC-012',
  'PROC-013',
  'PROC-016',
  'PROC-017',
  'PROC-019',
  'PROC-001',
  'PROC-002',
  'PROC-003',
  'PROC-004',
  'PB038-003',
  'PB149-OUTSOURCE-WIP-001',
  'PB154-OUTSOURCE-PAYABLE-001',
  'PB155-OUTSOURCE-INVOICE-001',
  'PB157-OUTSOURCE-CLOSE-001',
  'QUALITY-PENDING-001',
  'QUALITY-IQC-001',
  'QUALITY-IPQC-001',
  'QUALITY-OQC-001',
  'COST-001',
  'COST-004',
  'IOT-004',
  'IOT-002',
  'IOT-003',
  'IOT-009',
  'IOT-010',
  'MAINT-011',
  'HRM-001',
  'PMS-001',
  'OA-001',
  'PB040-001',
  'PB006-001',
  'MES-TASK-REPORT-001',
  'INT-001',
])

export function allDefinitions (sourceCatalog = catalog) {
  return sourceCatalog.suites.flatMap((suite) =>
    suite.cases.map((item) => ({ ...item, suite: suite.id }))
  )
}

export function validateCaseTimeoutMs (value) {
  if (!Number.isInteger(value) || value < 1000) {
    throw new Error(`--case-timeout-ms 必须是不小于 1000 的整数，当前=${value}`)
  }
  return value
}

export function parseParallelArgs (argv) {
  const args = {
    cases: [],
    suites: [],
    workers: Number(process.env.CFOR_E2E_PARALLEL_WORKERS || 3),
    caseTimeoutMs: Number(process.env.CFOR_E2E_CASE_TIMEOUT_MS || 180000),
    outputRoot: process.env.CFOR_E2E_OUT || '/tmp/cfor-e2e',
    headless: true,
    plan: false,
    help: false
  }
  const readValue = (index, option) => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${option} 缺少参数`)
    return value
  }
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (value === '--help' || value === '-h') args.help = true
    else if (value === '--case') { args.cases.push(readValue(index, value)); index++ }
    else if (value === '--suite') { args.suites.push(readValue(index, value)); index++ }
    else if (value === '--workers') { args.workers = Number(readValue(index, value)); index++ }
    else if (value === '--case-timeout-ms') { args.caseTimeoutMs = Number(readValue(index, value)); index++ }
    else if (value === '--out') { args.outputRoot = readValue(index, value); index++ }
    else if (value === '--headed') args.headless = false
    else if (value === '--headless') args.headless = true
    else if (value === '--plan') args.plan = true
    else throw new Error(`未知参数：${value}`)
  }
  if (!Number.isInteger(args.workers) || args.workers < 1) {
    throw new Error(`--workers 必须是大于 0 的整数，当前=${args.workers}`)
  }
  validateCaseTimeoutMs(args.caseTimeoutMs)
  return args
}

export function selectDefinitions ({
  definitions = allDefinitions(),
  cases = [],
  suites = [],
  safeOnly = true
} = {}) {
  const caseFilter = new Set(cases.filter(Boolean))
  const requestedSuites = suites.filter(Boolean)
  const suiteFilter = new Set(requestedSuites.filter((suite) => suite !== 'all'))
  const knownDefinitions = new Map(definitions.map((definition) => [definition.id, definition]))
  const knownSuites = new Set(definitions.map((definition) => definition.suite))
  const unknownSuites = [...suiteFilter].filter((suite) => !knownSuites.has(suite))
  if (unknownSuites.length) {
    throw new Error(`未知 suite：${unknownSuites.join(', ')}`)
  }
  if (caseFilter.size) {
    const unknown = [...caseFilter].filter((id) => !knownDefinitions.has(id))
    if (unknown.length) throw new Error(`未知 case：${unknown.join(', ')}`)
    const outsideSuites = [...caseFilter].filter((id) =>
      suiteFilter.size && !suiteFilter.has(knownDefinitions.get(id).suite)
    )
    if (outsideSuites.length) {
      throw new Error(`指定 case 与 suite 不匹配：${outsideSuites.join(', ')}`)
    }
    if (safeOnly) {
      const unsafe = [...caseFilter].filter((id) => {
        const definition = knownDefinitions.get(id)
        return definition.status === 'DESIGNED' ||
          definition.status === 'BLOCKED' ||
          !parallelSafeCases.has(id)
      })
      if (unsafe.length) {
        throw new Error(
          `以下 case 不属于并行只读池，请改用 runner.mjs 串行执行：${unsafe.join(', ')}`
        )
      }
    }
  }
  const selected = definitions.filter((definition) => {
    if (definition.status === 'DESIGNED' || definition.status === 'BLOCKED') return false
    if (caseFilter.size && !caseFilter.has(definition.id)) return false
    if (suiteFilter.size && !suiteFilter.has(definition.suite)) return false
    if (safeOnly && !parallelSafeCases.has(definition.id)) return false
    return true
  })
  return selected
}

export function partitionDefinitions (definitions = allDefinitions()) {
  return {
    parallel: definitions.filter((definition) => parallelSafeCases.has(definition.id)),
    serial: definitions.filter((definition) => !parallelSafeCases.has(definition.id))
  }
}

// Keep cases from the same business suite in one browser session.
export function groupDefinitionsBySuite (definitions = []) {
  const groups = new Map()
  for (const definition of definitions) {
    const suite = definition.suite || 'ungrouped'
    if (!groups.has(suite)) {
      groups.set(suite, {
        groupId: suite,
        suite,
        definitions: []
      })
    }
    groups.get(suite).definitions.push(definition)
  }
  return [...groups.values()]
}

function mkdir (directory) {
  fs.mkdirSync(directory, { recursive: true })
  return directory
}

function findResultFile (root) {
  const files = []
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (entry.isFile() && entry.name === 'result.json') files.push(target)
    }
  }
  visit(root)
  return files.sort().at(-1) || ''
}

export function summarizeResults (results) {
  const counts = { PASS: 0, PARTIAL: 0, FAIL: 0, BLOCKED: 0, SKIPPED: 0, ERROR: 0 }
  for (const result of results) {
    const status = result.status || 'ERROR'
    counts[status] = (counts[status] || 0) + 1
  }
  return {
    counts,
    failedCaseIds: results
      .filter((result) => ['FAIL', 'BLOCKED', 'ERROR'].includes(result.status))
      .map((result) => result.caseId),
    partialCaseIds: results
      .filter((result) => result.status === 'PARTIAL')
      .map((result) => result.caseId)
  }
}

export function terminateProcessTree (child, {
  kill = process.kill,
  killDelayMs = 5000
} = {}) {
  if (!child.pid) return () => {}
  const pid = process.platform === 'win32' ? child.pid : -child.pid
  try {
    kill(pid, 'SIGTERM')
  } catch {}
  const timer = setTimeout(() => {
    try {
      kill(pid, 'SIGKILL')
    } catch {}
  }, killDelayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export function processTreeHasExited (child, { kill = process.kill } = {}) {
  if (!child.pid || process.platform === 'win32') return false
  try {
    kill(-child.pid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

export function validateParallelPreflight ({ password = config.password } = {}) {
  if (!String(password || '').trim()) {
    throw new Error('缺少 CFOR_PASSWORD/CFOR_PASS，不能启动并行真实浏览器验收')
  }
}

export function waitForChildExit (child) {
  return new Promise((resolve) => {
    let error
    const onError = (value) => { error = value }
    const onClose = (exitCode, signal) => {
      child.removeListener('error', onError)
      resolve({ exitCode, signal, ...(error ? { error } : {}) })
    }
    child.on('error', onError)
    child.once('close', onClose)
  })
}

export function resultFromChildReport ({
  definition,
  record,
  report,
  exitCode,
  signal,
  logFile,
  grouped = false
}) {
  const caseRecord = record?.cases?.find((item) => item.id === definition.id)
  const status = caseRecord?.status || 'ERROR'
  const groupedExitHasNonPassCase = grouped &&
    exitCode === 1 &&
    record?.cases?.some((item) => item.status !== 'PASS')
  const abnormalExit = Boolean(signal) ||
    ![0, 1].includes(exitCode) ||
    (status === 'PASS' && exitCode !== 0 && !groupedExitHasNonPassCase)
  if (abnormalExit) {
    return {
      caseId: definition.id,
      suite: definition.suite,
      title: definition.title,
      status: 'ERROR',
      reportedStatus: status,
      exitCode,
      signal,
      error: `子进程异常退出（exitCode=${exitCode ?? 'null'}, signal=${signal || 'none'}），不能接受 ${status} 报告`,
      report,
      logFile
    }
  }
  return {
    caseId: definition.id,
    suite: definition.suite,
    title: definition.title,
    status,
    exitCode,
    signal,
    note: caseRecord?.notes?.join(' ') || '',
    report,
    logFile
  }
}

export function runChild ({
  definition,
  batchDir,
  headless,
  caseTimeoutMs,
  spawnChild = spawn,
  terminateChild = terminateProcessTree,
  terminationTimeoutMs = 7000,
  processTreeExited = processTreeHasExited,
  terminationPollMs = 50
}) {
  const startedAt = new Date().toISOString()
  const caseDir = mkdir(path.join(batchDir, 'workers', definition.id))
  const childEnv = {
    ...process.env,
    CFOR_TARGET: 'local',
    CFOR_WEB_BASE: process.env.CFOR_WEB_BASE || 'http://127.0.0.1:9151',
    CFOR_API_BASE: process.env.CFOR_API_BASE || 'http://127.0.0.1:48083',
    CFOR_E2E_OUT: caseDir,
    CFOR_EVIDENCE_DIR: caseDir,
    CFOR_E2E_HEADLESS: headless ? 'true' : 'false'
  }
  const args = [
    path.join(here, 'runner.mjs'),
    '--case',
    definition.id,
    '--case-timeout-ms',
    String(caseTimeoutMs),
    '--no-resume',
    '--no-reuse-session',
    ...(headless ? ['--headless'] : ['--headed'])
  ]
  const logFile = path.join(caseDir, 'worker.log')
  const output = fs.createWriteStream(logFile, { flags: 'w' })

  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    let timer
    let timeoutFallback
    let terminationProbeTimer
    let cancelTermination
    let closedExit
    const settle = (result, { cancelTerminationTimer = true } = {}) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (timeoutFallback) clearTimeout(timeoutFallback)
      if (terminationProbeTimer) clearTimeout(terminationProbeTimer)
      if (cancelTerminationTimer) cancelTermination?.()
      child.stdout?.unpipe(output)
      child.stderr?.unpipe(output)
      output.end()
      resolve({ ...result, startedAt, finishedAt: new Date().toISOString() })
    }
    const child = spawnChild(process.execPath, args, {
      cwd: path.resolve(here, '../..'),
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    })
    child.stdout?.pipe(output)
    child.stderr?.pipe(output)
    const confirmTermination = () => {
      if (settled) return
      if (!processTreeExited(child)) {
        terminationProbeTimer = setTimeout(confirmTermination, terminationPollMs)
        return
      }
      settle({
        caseId: definition.id,
        suite: definition.suite,
        title: definition.title,
        status: 'ERROR',
        exitCode: closedExit.exitCode,
        signal: closedExit.signal,
        error: `子进程超过 ${caseTimeoutMs}ms 未结束，已确认进程组退出并记录为 ERROR`,
        report: findResultFile(caseDir),
        logFile,
        timedOut: true
      })
    }
    waitForChildExit(child).then(({ error, exitCode, signal }) => {
      if (timedOut) {
        closedExit = { exitCode, signal }
        confirmTermination()
        return
      }
      if (error) {
        settle({
          caseId: definition.id,
          suite: definition.suite,
          title: definition.title,
          status: 'ERROR',
          exitCode: null,
          error: error.message,
          report: '',
          logFile
        })
        return
      }
      const report = findResultFile(caseDir)
      if (!report) {
        settle({
          caseId: definition.id,
          suite: definition.suite,
          title: definition.title,
          status: 'ERROR',
          exitCode,
          signal,
          error: `子进程未生成 result.json，详见 ${logFile}`,
          report,
          logFile
        })
        return
      }
      try {
        const record = JSON.parse(fs.readFileSync(report, 'utf8'))
        settle(resultFromChildReport({
          definition,
          record,
          report,
          exitCode,
          signal,
          logFile
        }))
      } catch (error) {
        settle({
          caseId: definition.id,
          suite: definition.suite,
          title: definition.title,
          status: 'ERROR',
          exitCode,
          signal,
          error: `result.json 解析失败：${error.message}`,
          report,
          logFile
        })
      }
    })
    timer = setTimeout(() => {
      if (settled || timedOut) return
      timedOut = true
      cancelTermination = terminateChild(child)
      timeoutFallback = setTimeout(() => {
        settle({
          caseId: definition.id,
          suite: definition.suite,
          title: definition.title,
          status: 'ERROR',
          exitCode: closedExit?.exitCode ?? null,
          signal: closedExit?.signal ?? null,
          error: `子进程超过 ${caseTimeoutMs}ms 未结束，无法确认进程组终止；停止派发后续案例`,
          childPid: child.pid ?? null,
          report: findResultFile(caseDir),
          logFile,
          timedOut: true,
          terminationWaitTimedOut: true
        }, { cancelTerminationTimer: false })
      }, terminationTimeoutMs)
    }, caseTimeoutMs)
  })
}

export function runGroupedChild ({
  definitions,
  batchDir,
  headless,
  caseTimeoutMs,
  spawnChild = spawn,
  terminateChild = terminateProcessTree,
  terminationTimeoutMs = 7000,
  processTreeExited = processTreeHasExited,
  terminationPollMs = 50
}) {
  if (!Array.isArray(definitions) || definitions.length === 0) {
    throw new Error('批量 worker 至少需要一个测试案例')
  }
  const suiteIds = new Set(definitions.map((definition) => definition.suite || 'ungrouped'))
  if (suiteIds.size !== 1) {
    throw new Error('批量 worker 只能运行同一 suite 的测试案例')
  }
  const caseIds = definitions.map((definition) => definition.id)
  if (new Set(caseIds).size !== caseIds.length) {
    throw new Error('批量 worker 不能包含重复的测试案例')
  }
  const groupId = definitions[0].suite || 'ungrouped'
  const startedAt = new Date().toISOString()
  const groupDir = mkdir(path.join(batchDir, 'workers', groupId))
  const groupTimeoutMs = caseTimeoutMs * definitions.length + 30000
  const childEnv = {
    ...process.env,
    CFOR_TARGET: 'local',
    CFOR_WEB_BASE: process.env.CFOR_WEB_BASE || 'http://127.0.0.1:9151',
    CFOR_API_BASE: process.env.CFOR_API_BASE || 'http://127.0.0.1:48083',
    CFOR_E2E_OUT: groupDir,
    CFOR_EVIDENCE_DIR: groupDir,
    CFOR_E2E_HEADLESS: headless ? 'true' : 'false'
  }
  const args = [
    path.join(here, 'runner.mjs'),
    ...definitions.flatMap((definition) => ['--case', definition.id]),
    '--case-timeout-ms',
    String(caseTimeoutMs),
    '--no-resume',
    '--reuse-session',
    '--continue-on-failure',
    ...(headless ? ['--headless'] : ['--headed'])
  ]
  const logFile = path.join(groupDir, 'worker.log')
  const output = fs.createWriteStream(logFile, { flags: 'w' })

  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    let timer
    let timeoutFallback
    let terminationProbeTimer
    let cancelTermination
    let closedExit
    const finish = (value, { cancelTerminationTimer = true } = {}) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (timeoutFallback) clearTimeout(timeoutFallback)
      if (terminationProbeTimer) clearTimeout(terminationProbeTimer)
      if (cancelTerminationTimer) cancelTermination?.()
      child.stdout?.unpipe(output)
      child.stderr?.unpipe(output)
      output.end()
      resolve({
        groupId,
        definitions,
        ...value,
        startedAt,
        finishedAt: new Date().toISOString()
      })
    }
    const child = spawnChild(process.execPath, args, {
      cwd: path.resolve(here, '../..'),
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    })
    child.stdout?.pipe(output)
    child.stderr?.pipe(output)
    const confirmTermination = () => {
      if (settled) return
      if (!processTreeExited(child)) {
        terminationProbeTimer = setTimeout(confirmTermination, terminationPollMs)
        return
      }
      finish({
        results: definitions.map((definition) => ({
          caseId: definition.id,
          suite: definition.suite,
          title: definition.title,
          status: 'ERROR',
          exitCode: closedExit.exitCode,
          signal: closedExit.signal,
          error: `批量 worker 超过 ${groupTimeoutMs}ms 未结束，已确认进程组退出`,
          report: findResultFile(groupDir),
          logFile,
          timedOut: true
        })),
        timedOut: true
      })
    }
    waitForChildExit(child).then(({ error, exitCode, signal }) => {
      if (timedOut) {
        closedExit = { exitCode, signal }
        confirmTermination()
        return
      }
      if (error) {
        finish({
          results: definitions.map((definition) => ({
            caseId: definition.id,
            suite: definition.suite,
            title: definition.title,
            status: 'ERROR',
            exitCode: null,
            error: error.message,
            report: '',
            logFile
          }))
        })
        return
      }
      const report = findResultFile(groupDir)
      if (!report) {
        finish({
          results: definitions.map((definition) => ({
            caseId: definition.id,
            suite: definition.suite,
            title: definition.title,
            status: 'ERROR',
            exitCode,
            signal,
            error: `批量 worker 未生成 result.json，详见 ${logFile}`,
            report,
            logFile
          }))
        })
        return
      }
      try {
        const record = JSON.parse(fs.readFileSync(report, 'utf8'))
        finish({
          results: definitions.map((definition) => resultFromChildReport({
            definition,
            record,
            report,
            exitCode,
            signal,
            logFile,
            grouped: true
          }))
        })
      } catch (parseError) {
        finish({
          results: definitions.map((definition) => ({
            caseId: definition.id,
            suite: definition.suite,
            title: definition.title,
            status: 'ERROR',
            exitCode,
            signal,
            error: `批量 result.json 解析失败：${parseError.message}`,
            report,
            logFile
          }))
        })
      }
    })
    timer = setTimeout(() => {
      if (settled || timedOut) return
      timedOut = true
      cancelTermination = terminateChild(child)
      timeoutFallback = setTimeout(() => {
        finish({
          results: definitions.map((definition) => ({
            caseId: definition.id,
            suite: definition.suite,
            title: definition.title,
            status: 'ERROR',
            exitCode: closedExit?.exitCode ?? null,
            signal: closedExit?.signal ?? null,
            error: `批量 worker 超过 ${groupTimeoutMs}ms 未结束，无法确认进程组终止`,
            report: findResultFile(groupDir),
            logFile,
            timedOut: true,
            terminationWaitTimedOut: true
          })),
          timedOut: true,
          terminationWaitTimedOut: true
        }, { cancelTerminationTimer: false })
      }, terminationTimeoutMs)
    }, groupTimeoutMs)
  })
}

export async function runPool (definitions, options, runCase = runChild) {
  const results = []
  let cursor = 0
  let aborted = false
  const worker = async () => {
    while (!aborted && cursor < definitions.length) {
      const definition = definitions[cursor++]
      console.log(`[parallel] RUN ${definition.id} ${definition.title}`)
      const result = await runCase({ definition, ...options })
      results.push(result)
      if (result.terminationWaitTimedOut) aborted = true
      console.log(`[parallel] ${result.status} ${definition.id}`)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(options.workers, definitions.length) }, worker)
  )
  for (const definition of definitions.slice(cursor)) {
    results.push({
      caseId: definition.id,
      suite: definition.suite,
      title: definition.title,
      status: 'SKIPPED',
      blockedByProcessTermination: true,
      note: '前序进程终止未确认，队列已停止，未启动此案例'
    })
  }
  return results.sort((left, right) => left.caseId.localeCompare(right.caseId))
}

export async function runGroupedPool (groups, options, runGroup = runGroupedChild) {
  const results = []
  let cursor = 0
  let aborted = false
  const worker = async () => {
    while (!aborted && cursor < groups.length) {
      const group = groups[cursor++]
      console.log(
        `[parallel] RUN suite=${group.suite} cases=${group.definitions.map((item) => item.id).join(',')}`
      )
      const result = await runGroup({ group, definitions: group.definitions, ...options })
      results.push(result)
      if (result.terminationWaitTimedOut) aborted = true
      for (const item of result.results || []) {
        console.log(`[parallel] ${item.status} ${item.caseId}`)
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(options.workers, groups.length) }, worker)
  )
  for (const group of groups.slice(cursor)) {
    results.push({
      groupId: group.groupId,
      definitions: group.definitions,
      results: group.definitions.map((definition) => ({
          caseId: definition.id,
          suite: definition.suite,
          title: definition.title,
          status: 'SKIPPED',
          blockedByProcessTermination: true,
          note: '前序批量 worker 终止未确认，队列已停止，未启动此案例'
      }))
    })
  }
  return results
}

export async function runBatch ({
  definitions,
  outputRoot,
  workers,
  headless,
  caseTimeoutMs = 180000
}) {
  validateCaseTimeoutMs(caseTimeoutMs)
  validateParallelPreflight()
  const startedAt = new Date().toISOString()
  const batchId = `parallel-${startedAt.replace(/[-:.TZ]/g, '')}-${process.pid}`
  const batchDir = mkdir(path.join(outputRoot, batchId))
  const groups = groupDefinitionsBySuite(definitions)
  const groupResults = await runGroupedPool(
    groups,
    { batchDir, workers, headless, caseTimeoutMs }
  )
  const results = groupResults.flatMap((group) => group.results || [])
  const summary = summarizeResults(results)
  const record = {
    batchId,
    startedAt,
    finishedAt: new Date().toISOString(),
    mode: 'parallel-suite-batched',
    workers,
    groups: groups.map((group) => ({
      suite: group.suite,
      caseIds: group.definitions.map((definition) => definition.id)
    })),
    caseTimeoutMs,
    selectedCases: definitions.map((definition) => definition.id),
    aborted: results.some((result) => result.terminationWaitTimedOut),
    unstartedCaseIds: results
      .filter((result) => result.blockedByProcessTermination)
      .map((result) => result.caseId),
    results,
    ...summary,
    retestRequired: summary.failedCaseIds.length > 0,
    restartRequiredBeforeRetest: summary.failedCaseIds.length ? null : false
  }
  fs.writeFileSync(
    path.join(batchDir, 'parallel-result.json'),
    JSON.stringify(record, null, 2)
  )
  const lines = [
    `# CFOR 并行验证批次（${batchId}）`,
    '',
    `- 并发数：${workers}`,
    `- 用例数：${definitions.length}`,
    `- 开始：${record.startedAt}`,
    `- 结束：${record.finishedAt}`,
    `- 因进程终止未确认而停止派发：${record.aborted ? '是' : '否'}`,
    `- 结果：${JSON.stringify(summary.counts)}`,
    `- 统一复测：${summary.failedCaseIds.length ? '需要' : '暂不需要'}`,
    '- 重启判断：仅业务应用修复需要重启；失败本身不自动触发重启',
    '',
    '| 用例 | 套件 | 状态 | 证据 | 日志 |',
    '|---|---|---|---|---|'
  ]
  for (const result of results) {
    lines.push(
      `| ${result.caseId} | ${result.suite} | ${result.status} | ${result.report || '-'} | ${result.logFile || '-'} |`
    )
  }
  lines.push('', '## 失败与部分通过', '')
  for (const caseId of [...summary.failedCaseIds, ...summary.partialCaseIds]) {
    lines.push(`- ${caseId}`)
  }
  fs.writeFileSync(path.join(batchDir, 'parallel-summary.md'), `${lines.join('\n')}\n`)
  return { batchDir, record }
}

function printPlan () {
  const definitions = allDefinitions()
  const eligible = definitions.filter(
    (definition) => !['DESIGNED', 'BLOCKED'].includes(definition.status)
  )
  const { parallel, serial } = partitionDefinitions(eligible)
  console.log(JSON.stringify({
    parallel: parallel.map((item) => item.id),
    serial: serial.map((item) => item.id),
    excluded: definitions
      .filter((definition) => ['DESIGNED', 'BLOCKED'].includes(definition.status))
      .map((item) => ({ id: item.id, status: item.status }))
  }, null, 2))
}

async function main () {
  const args = parseParallelArgs(process.argv.slice(2))
  if (args.help) {
    console.log([
      'Usage: node scripts/e2e/parallel-runner.mjs [options]',
      '  --plan                     Show parallel/serial groups without executing',
      '  --case ID                  Select safe cases (repeatable)',
      '  --suite ID                 Select safe suites (repeatable)',
      '  --workers N                Concurrent suite sessions (default 3)',
      '  --headed | --headless      Browser visibility',
      '  --case-timeout-ms N        Per-case timeout (default 180000)',
      '  --out PATH                 Evidence output directory',
      '  --help, -h                 Show usage without executing'
    ].join('\n'))
    return
  }
  if (args.plan) {
    printPlan()
    return
  }
  const definitions = selectDefinitions({
    cases: args.cases,
    suites: args.suites,
    safeOnly: true
  })
  if (!definitions.length) {
    throw new Error('没有可执行的并行只读用例；使用 --plan 查看并行/串行分组')
  }
  const result = await runBatch({
    definitions,
    outputRoot: args.outputRoot,
    workers: args.workers,
    headless: args.headless,
    caseTimeoutMs: args.caseTimeoutMs
  })
  console.log(`[parallel] batch=${result.batchDir}`)
  console.log(`[parallel] failed=${result.record.failedCaseIds.join(',') || '-'}`)
  console.log(`[parallel] partial=${result.record.partialCaseIds.join(',') || '-'}`)
  process.exit(
    result.record.failedCaseIds.length || result.record.partialCaseIds.length ? 1 : 0
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[parallel] fatal: ${error.stack || error.message || error}`)
    process.exit(2)
  })
}
