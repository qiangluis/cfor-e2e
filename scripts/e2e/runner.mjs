#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { config } from './config/index.mjs'
import { launchBrowser, saveScreenshot } from './lib/browser.mjs'
import { serverApiFailures } from './lib/api.mjs'
import {
  DEFAULT_API_READY_TIMEOUT_MS,
  DEFAULT_API_READY_INTERVAL_MS,
  DEFAULT_API_READY_REQUEST_TIMEOUT_MS,
  waitForApiReady
} from './lib/api-readiness.mjs'
import { checklist } from './lib/assert.mjs'
import {
  checkpointScope,
  implementationFingerprint,
  resumableCases
} from './lib/checkpoint.mjs'
import {
  createCaseRecord,
  createRunRecord,
  acceptanceIsComplete,
  caseOutcome,
  caseErrorStatus,
  finishCase,
  atomicWriteFile,
  reportSnapshot,
  writeProgress,
  writeReport
} from './lib/report.mjs'
import {
  caseFailureAction,
  DEFAULT_CASE_TIMEOUT_MS,
  parseRunnerArgs
} from './lib/runner-options.mjs'
import { loadPausedCatalog, pauseReasonFor } from './lib/paused.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const catalog = JSON.parse(fs.readFileSync(path.join(here, 'cases/catalog.json'), 'utf8'))
const pausedCatalog = loadPausedCatalog(path.join(here, 'cases/paused.json'))

const suiteFiles = {
  smoke: 'smoke.mjs',
  workbench: 'workbench.mjs',
  init: 'init.mjs',
  'erp-sales': 'erp-sales.mjs',
  procurement: 'procurement.mjs',
  'erp-logistics': 'erp-logistics.mjs',
  'erp-settlement': 'erp-settlement.mjs',
  'erp-account': 'erp-account.mjs',
  crm: 'crm.mjs',
  'mes-production': 'mes-production.mjs',
  'mes-aps': 'mes-aps.mjs',
  'mes-mrp': 'mes-mrp.mjs',
  'mes-base': 'mes-base.mjs',
  'mes-outsource': 'mes-outsource.mjs',
  'supplier-portal': 'supplier-portal.mjs',
  'mes-quality': 'mes-quality.mjs',
  'wms-quality': 'wms-quality.mjs',
  'wms-operation': 'wms-operation.mjs',
  'wms-transfer': 'wms-transfer.mjs',
  'wms-borrow': 'wms-borrow.mjs',
  fms: 'fms.mjs',
  cost: 'cost.mjs',
  plm: 'plm.mjs',
  'rdm-pms': 'pms-rdm.mjs',
  iot: 'iot.mjs',
  'iot-maintenance': 'iot-maintenance.mjs',
  integration: 'integration.mjs',
  'hrm-pms-oa': 'hrm-pms-oa.mjs',
  'project-after-sales': 'project-after-sales.mjs',
  'system-custom-field': 'system-custom-field.mjs',
  'system-data-permission': 'system-data-permission.mjs',
  'base-partner': 'base-partner.mjs',
  'mes-prod-task-report': 'mes-prod-task-report.mjs',
  'mes-monitor': 'mes-monitor.mjs',
  'bpm-business': 'bpm-business.mjs',
  'customer-portal': 'customer-portal.mjs',
  'erp-sale-order-lifecycle': 'erp-sale-order-lifecycle.mjs',
  'erp-sale-invoice-reversal': 'erp-sale-invoice-reversal.mjs',
  'erp-sale-return-receipt': 'erp-sale-return-receipt.mjs',
  'erp-receivable-receipt-writeoff': 'erp-receivable-receipt-writeoff.mjs',
  'erp-sale-reconciliation': 'erp-sale-reconciliation.mjs',
  'crm-contract-change': 'crm-contract-change.mjs',
  'crm-project-handover': 'crm-project-handover.mjs',
  'crm-sales-task': 'crm-sales-task.mjs',
  'crm-work-report': 'crm-work-report.mjs',
  'crm-business-report': 'crm-business-report.mjs',
  'crm-sales-plan': 'crm-sales-plan.mjs',
  'crm-sales-alignment': 'crm-sales-alignment.mjs'
}

const definitions = new Map(
  catalog.suites.flatMap((suite) =>
    suite.cases.map((item) => [item.id, { ...item, suite: suite.id }])
  )
)

function printList () {
  console.log('suite\tcaseId\tstatus\ttitle')
  for (const suite of catalog.suites) {
    for (const item of suite.cases) {
      console.log(`${suite.id}\t${item.id}\t${item.status || 'READY'}\t${item.title}`)
    }
  }
}

function orderedSuites (suites) {
  const byId = new Map(suites.map((suite) => [suite.id, suite]))
  const visited = new Set()
  const result = []
  const visit = (suite) => {
    if (visited.has(suite.id)) return
    visited.add(suite.id)
    for (const dependency of suite.dependsOn || []) {
      if (byId.has(dependency)) visit(byId.get(dependency))
    }
    result.push(suite)
  }
  suites.forEach(visit)
  return result
}

function caseIdsFor (args) {
  if (args.caseIds.length) {
    return args.caseIds.map((caseId) => {
      const definition = definitions.get(caseId)
      if (!definition) throw new Error(`未知 case：${caseId}`)
      return definition
    })
  }
  if (args.suite && args.suite !== 'all') {
    const suite = catalog.suites.find((item) => item.id === args.suite)
    if (!suite) throw new Error(`未知 suite：${args.suite}`)
    return suite.cases.map((item) => ({ ...item, suite: suite.id }))
  }
  return catalog.suites.flatMap((suite) =>
    suite.cases.map((item) => ({ ...item, suite: suite.id }))
  )
}

let runCheckpointScope

function checkpointPath () {
  runCheckpointScope ||= checkpointScope({
    environment: [
      config.target, config.webBase, config.apiUrl, config.tenantId,
      config.tenantName, config.username, config.db.name,
      config.purchaseApproverUsername, config.financeApproverUsername, config.finalApproverUsername,
      config.warehouseApproverUsername, config.warehouseFinalApproverUsername
    ],
    catalog,
    implementation: implementationFingerprint(here)
  })
  return path.join(config.evidenceDir, 'checkpoints', `${runCheckpointScope}.json`)
}

function loadCheckpoint () {
  try {
    const value = JSON.parse(fs.readFileSync(checkpointPath(), 'utf8'))
    return resumableCases(value.completedCases, definitions)
  } catch {
    return new Set()
  }
}

function saveCheckpoint (caseId) {
  fs.mkdirSync(path.dirname(checkpointPath()), { recursive: true })
  const completedCases = [...loadCheckpoint()]
  if (!completedCases.includes(caseId)) completedCases.push(caseId)
  atomicWriteFile(
    checkpointPath(),
    JSON.stringify({ updatedAt: new Date().toISOString(), completedCases }, null, 2)
  )
}

function clearCheckpoint () {
  try { fs.unlinkSync(checkpointPath()) } catch {}
}

export function selectedResumeCases (completed, selectedCases) {
  return new Set([...completed].filter((caseId) => selectedCases.has(caseId)))
}

function reconcileCheckpoint (record) {
  const file = checkpointPath()
  if (!fs.existsSync(file)) return
  const checkpoint = JSON.parse(fs.readFileSync(file, 'utf8'))
  const revoked = new Set(record.cases.filter((item) =>
    item.status !== 'PASS' &&
    !(item.status === 'SKIPPED' && item.notes?.includes('断点续跑：此前已通过'))
  ).map((item) => item.caseId || item.id))
  const completedCases = (checkpoint.completedCases || []).filter((id) => !revoked.has(id))
  atomicWriteFile(file, JSON.stringify({
    ...checkpoint, updatedAt: new Date().toISOString(), completedCases
  }, null, 2))
}

function filterAllowedRuntimeErrors (runtimeErrors, allowRuntimeErrors = {}) {
  return Object.fromEntries(
    Object.entries(runtimeErrors).map(([type, errors]) => {
      const allow = type === 'nodeApi' ? undefined : allowRuntimeErrors[type]
      if (typeof allow !== 'function') return [type, errors]
      return [type, errors.filter((error) => !allow(error))]
    })
  )
}

export function caseRuntimeErrors (record, before) {
  return {
    console: record.consoleErrors.slice(before.console),
    page: record.pageErrors.slice(before.page),
    api: record.failedApiResponses.slice(before.api),
    request: record.requestFailures.slice(before.request),
    // Keep Node API failures fail-closed; only the API client may mark an
    // explicitly matched 2xx business rejection as non-runtime evidence.
    nodeApi: serverApiFailures(record.api.slice(before.apiRequests))
  }
}

async function loadSuite (suiteId) {
  const file = suiteFiles[suiteId] || `${suiteId}.mjs`
  const target = path.join(here, 'suites', file)
  if (!fs.existsSync(target)) throw new Error(`套件文件不存在：${suiteId} -> ${target}`)
  return import(`./suites/${file}`)
}

async function closeWithTimeout (operation, label, timeoutMs = 15000) {
  let timer
  try {
    await Promise.race([
      operation,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[e2e] ${label} cleanup timed out after ${timeoutMs}ms`)
          resolve()
        }, timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function closeBrowserHandle (handle, tracePath, label = 'browser') {
  if (!handle) return
  fs.mkdirSync(path.dirname(tracePath), { recursive: true })
  await closeWithTimeout(
    handle.flushResponses().catch(() => {}),
    `${label} response flush`,
    15000
  )
  await closeWithTimeout(
    handle.context.tracing.stop({ path: tracePath }).catch(() => {}),
    `${label} trace`,
    15000
  )
  await closeWithTimeout(
    handle.context.close().catch(() => {}),
    `${label} context`,
    15000
  )
  await closeWithTimeout(
    handle.browser.close().catch(() => {}),
    `${label} browser`,
    15000
  )
}

export function finalizeCaseRecord (caseRecord) {
  const snapshot = reportSnapshot(caseRecord)
  const freeze = (value) => {
    if (!value || typeof value !== 'object') return value
    Object.values(value).forEach(freeze)
    return Object.freeze(value)
  }
  return freeze(snapshot)
}

export function persistFinalizedCase (record, index, caseRecord, options = {}) {
  const snapshot = finalizeCaseRecord(caseRecord)
  record.cases[index] = snapshot
  writeProgress(record, { ...options, caseRecord: snapshot })
  return snapshot
}

export async function runCaseWithTimeout (operation, timeoutMs, caseId, onTimeout) {
  let timer
  let timedOut = false
  const settled = Promise.resolve(operation).then(() => {}, () => {})
  try {
    return await Promise.race([
      operation,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(new Error(`案例 ${caseId} 超过 ${timeoutMs}ms 未完成，已终止等待`))
        }, timeoutMs)
      })
    ])
  } catch (error) {
    if (timedOut) {
      // Closing the browser interrupts UI waits; it does not cancel API fixtures.
      // Never start another case while the original operation is still running.
      try {
        await onTimeout?.()
      } catch (cleanupError) {
        error.cause = cleanupError
      } finally {
        await settled
      }
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function main (dependencies = {}) {
  const settings = dependencies.config || config
  const persistOptions = { outputRoot: settings.outputRoot, settings }
  const launch = dependencies.launchBrowser || launchBrowser
  const close = dependencies.closeBrowserHandle || closeBrowserHandle
  const checkpoint = dependencies.saveCheckpoint || saveCheckpoint
  const persist = dependencies.persistFinalizedCase || persistFinalizedCase
  const progress = dependencies.writeProgress || writeProgress
  const reportWriter = dependencies.writeReport || writeReport
  const args = parseRunnerArgs(dependencies.argv || process.argv.slice(2), {
    reuseSession: config.reuseSession,
    caseTimeoutMs: Number(process.env.CFOR_E2E_CASE_TIMEOUT_MS || DEFAULT_CASE_TIMEOUT_MS)
  })
  if (args.help) {
    console.log([
      'Usage: node scripts/e2e/runner.mjs [options]',
      '  --list                     List cases without executing',
      '  --suite ID                 Select one suite (all by default)',
      '  --case ID                  Select cases (repeatable)',
      '  --headed | --headless      Browser visibility',
      '  --reuse-session            Reuse browser/login session',
      '  --no-reuse-session         Use independent browser sessions',
      '  --resume | --fresh         Use or ignore checkpoints',
      '  --continue-on-failure      Continue isolated cases after failure',
      '  --case-timeout-ms N        Per-case timeout (default 180000)',
      '  --help, -h                 Show usage without executing',
      '  CFOR_E2E_OUT               Evidence output directory',
      '  CFOR_E2E_API_READY_TIMEOUT_MS  Batch health wait (default 900000)',
      '  CFOR_E2E_API_READY_INTERVAL_MS Poll interval (default 2000)',
      '  CFOR_E2E_API_READY_REQUEST_TIMEOUT_MS  Health request timeout (default 5000)'
    ].join('\n'))
    return
  }
  if (args.list) return printList()
  if (!settings.password) throw new Error('缺少 CFOR_PASSWORD/CFOR_PASS，不能启动真实浏览器验收')
  if (settings.target === 'local') {
    for (const [label, base, port] of [
      ['前端', settings.webBase, '9151'],
      ['后端', settings.apiBase, '48083']
    ]) {
      const url = new URL(base)
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.port !== port) {
        throw new Error(`本地验收${label}仅允许回环地址端口 ${port}，当前=${base}`)
      }
    }
  }

  const selectedDefinitions = caseIdsFor(args)
  const selectedSuiteIds = [...new Set(selectedDefinitions.map((item) => item.suite))]
  const selectedSuites = orderedSuites(
    catalog.suites.filter((suite) => selectedSuiteIds.includes(suite.id))
  )
  const selectedCases = new Set(selectedDefinitions.map((item) => item.id))
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${process.pid}`
  const record = createRunRecord({
    selectedSuites: selectedSuites.map((suite) => suite.id),
    selectedCases: [...selectedCases]
  })
  record.runId = runId
  record.environment.target = settings.target
  record.environment.webBase = settings.webBase
  record.environment.apiBase = settings.apiUrl

  if (!args.resume) (dependencies.clearCheckpoint || clearCheckpoint)()
  const completed = selectedResumeCases(
    args.resume ? (dependencies.loadCheckpoint || loadCheckpoint)() : new Set(),
    selectedCases
  )
  let browserHandle
  let fatalError
  const loadedModules = new Map()

  progress(record, { ...persistOptions, phase: 'API_READINESS' })
  console.log(`[e2e] target=${settings.target} web=${settings.webBase} api=${settings.apiUrl}`)
  console.log(`[e2e] suites=${selectedSuites.map((suite) => suite.id).join(', ')}`)
  if (completed.size) console.log(`[e2e] resume: skip ${completed.size} passed cases`)

  try {
    let lastReadinessLogMs = -Infinity
    record.apiReadiness = await (dependencies.waitForApiReady || waitForApiReady)({
      settings,
      timeoutMs: Number(process.env.CFOR_E2E_API_READY_TIMEOUT_MS || DEFAULT_API_READY_TIMEOUT_MS),
      intervalMs: Number(process.env.CFOR_E2E_API_READY_INTERVAL_MS || DEFAULT_API_READY_INTERVAL_MS),
      requestTimeoutMs: Number(process.env.CFOR_E2E_API_READY_REQUEST_TIMEOUT_MS || DEFAULT_API_READY_REQUEST_TIMEOUT_MS),
      onAttempt: (attempt) => {
        if (attempt.attempt === 1 || attempt.elapsedMs - lastReadinessLogMs >= 30000) {
          lastReadinessLogMs = attempt.elapsedMs
          console.log(`[e2e] API readiness: attempt=${attempt.attempt} elapsedMs=${Math.round(attempt.elapsedMs)} HTTP=${attempt.httpStatus ?? 'unavailable'} status=${attempt.healthStatus ?? 'unknown'}`)
        }
      }
    })
    console.log(`[e2e] API readiness: ${record.apiReadiness.status}`)
    progress(record, persistOptions)
    suites: for (const suite of selectedSuites) {
      const module = await (dependencies.loadSuite || loadSuite)(suite.id)
      loadedModules.set(suite.id, module)
      const runnableCases = new Set(module.cases || suite.cases.map((item) => item.id))
      for (const definition of suite.cases) {
        if (!selectedCases.has(definition.id)) continue
        const caseDefinition = { ...definition, suite: suite.id }
        let caseRecord = createCaseRecord(caseDefinition)
        for (const gap of definition.acceptanceGaps || []) caseRecord.notes.push(`GAP: ${gap}`)
        const caseRecordIndex = record.cases.length
        record.cases.push(caseRecord)
        progress(record, persistOptions)
        const declaredStatus = definition.status || 'READY'

        const pauseReason = pauseReasonFor(caseDefinition, pausedCatalog)
        if (pauseReason) {
          finishCase(caseRecord, 'SKIPPED', `已暂停自动化：${pauseReason}`)
          persist(record, caseRecordIndex, caseRecord, persistOptions)
          continue
        }
        if (completed.has(definition.id)) {
          finishCase(caseRecord, 'SKIPPED', '断点续跑：此前已通过')
          persist(record, caseRecordIndex, caseRecord, persistOptions)
          continue
        }
        if (declaredStatus === 'DESIGNED' || declaredStatus === 'BLOCKED') {
          finishCase(
            caseRecord,
            'SKIPPED',
            definition.registration
              ? `${declaredStatus}：${definition.registration}`
              : `${declaredStatus}：当前没有完整可执行步骤，未伪造通过`
          )
          persist(record, caseRecordIndex, caseRecord, persistOptions)
          continue
        }
        if (!runnableCases.has(definition.id)) {
          finishCase(caseRecord, 'PARTIAL', '目录中有用例，但套件未实现对应步骤')
          persist(record, caseRecordIndex, caseRecord, persistOptions)
          continue
        }

        if (!browserHandle) {
          browserHandle = await launch({
            headed: args.headed,
            record
          })
          await browserHandle.context.tracing.start({
            screenshots: true,
            snapshots: true,
            sources: false
          })
        }

        const outputDir = path.join(settings.outputRoot, record.runId, 'screenshots')
        const check = checklist()
        const startedAt = Date.now()
        const errorsBefore = {
          console: record.consoleErrors.length, page: record.pageErrors.length,
          api: record.failedApiResponses.length, request: record.requestFailures.length,
          apiRequests: record.api.length
        }
        console.log(`[RUN ] ${definition.id} ${definition.title}`)
        try {
          const result = await runCaseWithTimeout(
            module.runCase({
              caseId: definition.id,
              suiteId: suite.id,
              page: browserHandle.page,
              context: browserHandle.context,
              record,
              caseRecord,
              outputDir,
              shotDir: outputDir,
              check,
              ctx: {
                browser: browserHandle.browser,
                context: browserHandle.context,
                page: browserHandle.page
              }
            }),
            args.caseTimeoutMs,
            definition.id,
            async () => {
              const handle = browserHandle
              browserHandle = undefined
              // Interrupt pending Playwright actions before response/trace cleanup.
              await closeWithTimeout(
                handle.context.close().catch(() => {}),
                `${definition.id} timeout context`
              )
              await close(
                handle,
                path.join(settings.outputRoot, record.runId, 'trace', `${definition.id}-FAIL.zip`),
                `${definition.id} timeout`
              )
            }
          )
          await closeWithTimeout(
            browserHandle.flushResponses(),
            'response flush',
            15000
          )
          const hasAssertions = caseRecord.checks.length + check.steps.length > 0
          const runtimeErrors = caseRuntimeErrors(record, errorsBefore)
          caseRecord.runtimeErrors = filterAllowedRuntimeErrors(
            runtimeErrors,
            result?.allowRuntimeErrors
          )
          caseRecord.checks.push({
            name: '本用例无控制台错误、页面异常、浏览器业务 API 错误、Node API 服务异常或请求失败',
            passed: Object.values(caseRecord.runtimeErrors).every((items) => items.length === 0),
            details: JSON.stringify(caseRecord.runtimeErrors).slice(0, 1000)
          })
          caseRecord.checks.push(...check.steps)
          const failedChecks = caseRecord.checks.filter((item) => item.passed === false)
          const catalogAcceptanceComplete =
            Array.isArray(caseRecord.catalogAssertions) &&
            caseRecord.catalogAssertions.length > 0 &&
            caseRecord.catalogAssertions.every((item) =>
              item.status === 'VERIFIED' &&
              (
                (Array.isArray(item.evidenceChecks) && item.evidenceChecks.length > 0) ||
                (typeof item.evidence === 'string' && item.evidence.trim() !== '') ||
                result?.status === 'PASS'
              )
            )
          const explicitlyIncomplete = Boolean(
            result?.partial || result?.notImplemented || result?.designed ||
            result?.blocked || result?.skipped || result?.acceptanceComplete === false ||
            caseRecord.acceptanceComplete === false || caseRecord.passCandidate === false
          )
          const acceptanceComplete = acceptanceIsComplete({
            failedChecks,
            remainingAssertions: caseRecord.remainingAssertions,
            incomplete: explicitlyIncomplete,
            candidates: [
              result?.acceptanceComplete,
              caseRecord.acceptanceComplete,
              caseRecord.passCandidate,
              catalogAcceptanceComplete
            ]
          })
          const partial = !acceptanceComplete && (
            explicitlyIncomplete ||
            Boolean(caseRecord.remainingAssertions?.length) ||
            declaredStatus === 'PARTIAL' ||
            Boolean(definition.acceptanceGaps?.length) ||
            result?.notImplemented ||
            result?.designed ||
            result?.partial
          )
          const outcome = caseOutcome({
            failedChecks,
            partial,
            hasAssertions,
            result: {
              ...(result || {}),
              acceptanceComplete
            }
          })
          finishCase(caseRecord, outcome.status, outcome.note)
          caseRecord.durationMs = Date.now() - startedAt
          console.log(`[${caseRecord.status}] ${definition.id}`)
        } catch (error) {
          if (browserHandle) {
            await closeWithTimeout(
              browserHandle.flushResponses().catch(() => {}),
              'response flush after failure',
              15000
            )
          }
          caseRecord.runtimeErrors = caseRuntimeErrors(record, errorsBefore)
          caseRecord.checks.push({
            name: '失败现场的控制台、页面、业务 API 与请求错误',
            passed: Object.values(caseRecord.runtimeErrors).every((items) => items.length === 0),
            details: JSON.stringify(caseRecord.runtimeErrors).slice(0, 1000)
          })
          caseRecord.checks.push(...check.steps.filter((step) => !caseRecord.checks.includes(step)))
          caseRecord.durationMs = Date.now() - startedAt
          if (browserHandle) {
            await (dependencies.saveScreenshot || saveScreenshot)(
              browserHandle.page, outputDir, `${definition.id}-FAIL`, record
            ).catch(() => {})
          }
          finishCase(
            caseRecord,
            caseErrorStatus(error, caseRecord.checks),
            String(error.message || error).slice(0, 1000)
          )
          console.log(`[${caseRecord.status}] ${definition.id} ${reportSnapshot(String(error.message || error), { settings })}`)
        }
        caseRecord = persist(record, caseRecordIndex, caseRecord, persistOptions)
        if (caseRecord.status === 'PASS') checkpoint(definition.id)
        const failureAction = caseFailureAction(
          caseRecord.status,
          args.continueOnFailure
        )
        if (failureAction === 'stop') {
          console.log('[e2e] 当前用例未通过，停止后续用例，修复并重启后再续跑')
          break suites
        }
        if (failureAction === 'continue-isolated' && browserHandle) {
          const tracePath = path.join(
            settings.outputRoot,
            record.runId,
            'trace',
            `${definition.id}-FAIL.zip`
          )
          await close(browserHandle, tracePath, `${definition.id} failure`)
          browserHandle = undefined
          console.log('[e2e] continue-on-failure：已关闭失败用例浏览器，下一例使用隔离上下文')
        }
        if (!args.reuseSession && browserHandle) {
          const tracePath = path.join(settings.outputRoot, record.runId, 'trace', `${definition.id}.zip`)
          fs.mkdirSync(path.dirname(tracePath), { recursive: true })
          await close(browserHandle, tracePath, definition.id)
          browserHandle = undefined
        }
      }
    }
  } catch (error) {
    fatalError = error
    if (error.readiness) record.apiReadiness = error.readiness
    record.runError = reportSnapshot(error, { settings })
  } finally {
    try {
      await finalizeSuiteSessions(loadedModules, record, {
        afterSuite: () => {
          progress(record, { ...persistOptions, phase: 'TEARDOWN' })
          ;(dependencies.reconcileCheckpoint || reconcileCheckpoint)(record)
        }
      })
    } finally {
      if (browserHandle) {
        const tracePath = path.join(settings.outputRoot, record.runId, 'trace', 'browser.zip')
        fs.mkdirSync(path.dirname(tracePath), { recursive: true })
        await close(browserHandle, tracePath)
      }
    }
  }

  progress(record, { ...persistOptions, phase: 'TEARDOWN' })
  ;(dependencies.reconcileCheckpoint || reconcileCheckpoint)(record)
  if (fatalError?.code === 'E2E_REPORT_PERSISTENCE_FAILED') throw fatalError
  const report = await reportWriter(record, persistOptions)
  console.log(`[e2e] report=${report.resultFile}`)
  if (fatalError) throw fatalError
  return { record, report }
}

export async function finalizeSuiteSessions (modules, record, { afterSuite } = {}) {
  for (const [suiteId, module] of modules) {
    if (typeof module.teardownRun !== 'function') continue
    // Teardown hooks may correct case evidence; the saved pre-teardown snapshots stay immutable.
    record.cases = record.cases.map((entry) =>
      entry.suite === suiteId ? structuredClone(entry) : entry)
    try {
      await module.teardownRun({ record })
    } catch (error) {
      const owner = record.cases.findLast((entry) => entry.suite === suiteId)
      if (!owner) throw error
      owner.checks.push({
        name: `${suiteId} 整轮会话与专属账号清理`,
        passed: false,
        details: String(error.message || error).slice(0, 1000)
      })
      finishCase(owner, 'FAIL', `整轮清理失败：${error.message || error}`)
    } finally {
      record.cases = record.cases.map((entry) =>
        entry.suite === suiteId ? finalizeCaseRecord(entry) : entry)
      await afterSuite?.(suiteId)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(({ record } = {}) => {
    if (record) process.exitCode = record.passed ? 0 : 1
  }).catch((error) => {
    console.error(`[e2e] fatal: ${reportSnapshot(String(error.stack || error.message || error))}`)
    process.exitCode = 2
  })
}
