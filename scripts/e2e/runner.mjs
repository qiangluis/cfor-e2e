#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config/index.mjs'
import { launchBrowser, saveScreenshot } from './lib/browser.mjs'
import { checklist } from './lib/assert.mjs'
import {
  checkpointScope,
  implementationFingerprint,
  resumableCases
} from './lib/checkpoint.mjs'
import {
  createCaseRecord,
  createRunRecord,
  caseOutcome,
  caseErrorStatus,
  finishCase,
  writeReport
} from './lib/report.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const catalog = JSON.parse(fs.readFileSync(path.join(here, 'cases/catalog.json'), 'utf8'))

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
  'mes-monitor': 'mes-monitor.mjs'
}

function parseArgs (argv) {
  const args = {
    list: false,
    suite: '',
    caseId: '',
    headed: false,
    resume: false,
    reuseSession: config.reuseSession
  }
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (value === '--list') args.list = true
    else if (value === '--suite') args.suite = argv[++index]
    else if (value === '--case') args.caseId = argv[++index]
    else if (value === '--headed' || value === '--no-headless') args.headed = true
    else if (value === '--headless') args.headed = false
    else if (value === '--resume') args.resume = true
    else if (value === '--fresh' || value === '--no-resume') args.resume = false
    else if (value === '--reuse-session') args.reuseSession = true
    else if (value === '--no-reuse-session') args.reuseSession = false
  }
  return args
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
  if (args.caseId) {
    const definition = definitions.get(args.caseId)
    if (!definition) throw new Error(`未知 case：${args.caseId}`)
    return [definition]
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
      config.purchaseApproverUsername, config.financeApproverUsername, config.finalApproverUsername
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
  fs.writeFileSync(
    checkpointPath(),
    JSON.stringify({ updatedAt: new Date().toISOString(), completedCases }, null, 2)
  )
}

function clearCheckpoint () {
  try { fs.unlinkSync(checkpointPath()) } catch {}
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

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.list) return printList()
  if (!config.password) throw new Error('缺少 CFOR_PASSWORD/CFOR_PASS，不能启动真实浏览器验收')
  if (config.target === 'local') {
    for (const [label, base, port] of [
      ['前端', config.webBase, '9151'],
      ['后端', config.apiBase, '48083']
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
  record.environment.webBase = config.webBase
  record.environment.apiBase = config.apiUrl

  if (!args.resume) clearCheckpoint()
  const completed = args.resume ? loadCheckpoint() : new Set()
  let browserHandle

  console.log(`[e2e] target=${config.target} web=${config.webBase} api=${config.apiUrl}`)
  console.log(`[e2e] suites=${selectedSuites.map((suite) => suite.id).join(', ')}`)
  if (completed.size) console.log(`[e2e] resume: skip ${completed.size} passed cases`)

  try {
    suites: for (const suite of selectedSuites) {
      const module = await loadSuite(suite.id)
      const runnableCases = new Set(module.cases || suite.cases.map((item) => item.id))
      for (const definition of suite.cases) {
        if (!selectedCases.has(definition.id)) continue
        const caseDefinition = { ...definition, suite: suite.id }
        const caseRecord = createCaseRecord(caseDefinition)
        record.cases.push(caseRecord)
        const declaredStatus = definition.status || 'READY'

        if (completed.has(definition.id)) {
          finishCase(caseRecord, 'SKIPPED', '断点续跑：此前已通过')
          continue
        }
        if (declaredStatus === 'DESIGNED' || declaredStatus === 'BLOCKED') {
          finishCase(
            caseRecord,
            'SKIPPED',
            `${declaredStatus}：当前没有完整可执行步骤，未伪造通过`
          )
          continue
        }
        if (!runnableCases.has(definition.id)) {
          finishCase(caseRecord, 'PARTIAL', '目录中有用例，但套件未实现对应步骤')
          continue
        }

        if (!browserHandle) {
          browserHandle = await launchBrowser({
            headed: args.headed,
            record
          })
          await browserHandle.context.tracing.start({
            screenshots: true,
            snapshots: true,
            sources: false
          })
        }

        const outputDir = path.join(config.outputRoot, record.runId, 'screenshots')
        const check = checklist()
        const startedAt = Date.now()
        const errorsBefore = {
          console: record.consoleErrors.length, page: record.pageErrors.length,
          api: record.failedApiResponses.length, request: record.requestFailures.length
        }
        console.log(`[RUN ] ${definition.id} ${definition.title}`)
        try {
          const result = await module.runCase({
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
          })
          await browserHandle.flushResponses()
          const hasAssertions = caseRecord.checks.length + check.steps.length > 0
          caseRecord.runtimeErrors = {
            console: record.consoleErrors.slice(errorsBefore.console),
            page: record.pageErrors.slice(errorsBefore.page),
            api: record.failedApiResponses.slice(errorsBefore.api),
            request: record.requestFailures.slice(errorsBefore.request)
          }
          caseRecord.checks.push({
            name: '本用例无控制台错误、页面异常、浏览器业务 API 错误或请求失败',
            passed: Object.values(caseRecord.runtimeErrors).every((items) => items.length === 0),
            details: JSON.stringify(caseRecord.runtimeErrors).slice(0, 1000)
          })
          caseRecord.checks.push(...check.steps)
          const failedChecks = caseRecord.checks.filter((item) => item.passed === false)
          const partial = declaredStatus === 'PARTIAL' || result?.notImplemented || result?.designed || result?.partial
          const outcome = caseOutcome({ failedChecks, partial, hasAssertions, result })
          finishCase(caseRecord, outcome.status, outcome.note)
          if (outcome.status === 'PASS') saveCheckpoint(definition.id)
          caseRecord.durationMs = Date.now() - startedAt
          console.log(`[${caseRecord.status}] ${definition.id}`)
        } catch (error) {
          await browserHandle.flushResponses()
          caseRecord.runtimeErrors = {
            console: record.consoleErrors.slice(errorsBefore.console),
            page: record.pageErrors.slice(errorsBefore.page),
            api: record.failedApiResponses.slice(errorsBefore.api),
            request: record.requestFailures.slice(errorsBefore.request)
          }
          caseRecord.checks.push({
            name: '失败现场的控制台、页面、业务 API 与请求错误',
            passed: Object.values(caseRecord.runtimeErrors).every((items) => items.length === 0),
            details: JSON.stringify(caseRecord.runtimeErrors).slice(0, 1000)
          })
          caseRecord.checks.push(...check.steps.filter((step) => !caseRecord.checks.includes(step)))
          caseRecord.durationMs = Date.now() - startedAt
          finishCase(
            caseRecord,
            caseErrorStatus(error, caseRecord.checks),
            String(error.message || error).slice(0, 1000)
          )
          await saveScreenshot(browserHandle.page, outputDir, `${definition.id}-FAIL`, record).catch(() => {})
          console.log(`[${caseRecord.status}] ${definition.id} ${error.message || error}`)
        }
        if (['FAIL', 'BLOCKED'].includes(caseRecord.status)) {
          console.log('[e2e] 当前用例未通过，停止后续用例，修复并重启后再续跑')
          break suites
        }
        if (!args.reuseSession && browserHandle) {
          const tracePath = path.join(config.outputRoot, record.runId, 'trace', `${definition.id}.zip`)
          fs.mkdirSync(path.dirname(tracePath), { recursive: true })
          await browserHandle.context.tracing.stop({ path: tracePath })
          await browserHandle.browser.close()
          browserHandle = undefined
        }
      }
    }
  } finally {
    if (browserHandle) {
      const tracePath = path.join(config.outputRoot, record.runId, 'trace', 'browser.zip')
      fs.mkdirSync(path.dirname(tracePath), { recursive: true })
      await closeWithTimeout(
        browserHandle.context.tracing.stop({ path: tracePath }).catch(() => {}),
        'trace'
      )
      await closeWithTimeout(browserHandle.context.close().catch(() => {}), 'browser context')
      await closeWithTimeout(browserHandle.browser.close().catch(() => {}), 'browser')
    }
  }

  const report = await writeReport(record)
  console.log(`[e2e] report=${report.resultFile}`)
  process.exit(record.passed ? 0 : 1)
}

main().catch((error) => {
  console.error(`[e2e] fatal: ${error.stack || error.message || error}`)
  process.exit(2)
})
