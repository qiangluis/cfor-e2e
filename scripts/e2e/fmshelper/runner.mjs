#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config/index.mjs'
import { launchBrowser, saveScreenshot } from '../lib/browser.mjs'
import { apiHealth } from '../lib/api.mjs'
import {
  createRunRecord, createCaseRecord, finishCase, caseErrorStatus, writeReport
} from '../lib/report.mjs'
import { runCase } from '../suites/fms.mjs'
import { assertEnvironment, catalogResult, ownedCases } from './contracts.mjs'

assertEnvironment()
const args = process.argv.slice(2)
if (!args.includes('--headed')) throw new Error('本组定向 runner 必须使用 --headed')
if (!args.includes('--fresh')) throw new Error('本组定向 runner 必须使用 --fresh')
if (!args.includes('--continue-on-failure')) {
  throw new Error('本组定向 runner 必须使用 --continue-on-failure')
}
const requested = args.filter((value, index) => args[index - 1] === '--case')
const selected = requested.length ? requested : ownedCases
if (selected.some((id) => !ownedCases.includes(id))) throw new Error('仅允许独占的 FMS-001..007')
const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
const definitions = catalog.suites.find((suite) => suite.id === 'fms').cases
const record = createRunRecord({ selectedSuites: ['fms'], selectedCases: selected })
record.runner = 'independent-fms-catalog-evidence'
const root = path.join(config.outputRoot, record.runId)
fs.mkdirSync(root, { recursive: true })
await apiHealth()
for (const caseId of selected) {
  const definition = definitions.find((item) => item.id === caseId)
  const item = createCaseRecord({ ...definition, suite: 'fms' })
  item.declaredCatalogStatus = definition.status
  record.cases.push(item)
  const start = Date.now()
  const h = await launchBrowser({ headed: true, record })
  const before = {
    console: record.consoleErrors.length, page: record.pageErrors.length,
    api: record.failedApiResponses.length, request: record.requestFailures.length
  }
  const shots = path.join(root, 'screenshots', caseId)
  fs.mkdirSync(shots, { recursive: true })
  await h.context.tracing.start({ screenshots: true, snapshots: true, sources: false })
  console.log(`[RUN] ${caseId} catalog=${definition.status}`)
  try {
    const result = await runCase({ caseId, page: h.page, context: h.context,
      record, caseRecord: item, outputDir: shots })
    await h.flushResponses()
    item.runtimeErrors = {
      console: record.consoleErrors.slice(before.console),
      page: record.pageErrors.slice(before.page),
      api: record.failedApiResponses.slice(before.api),
      request: record.requestFailures.slice(before.request)
    }
    item.checks.push({
      name: '本轮 Chrome 无控制台/页面/业务 API/请求错误',
      passed: Object.values(item.runtimeErrors).every((items) => items.length === 0),
      details: JSON.stringify(item.runtimeErrors)
    })
    const coverage = catalogResult(item, definition)
    const failed = item.checks.some((check) => check.passed === false)
    finishCase(item, failed ? 'FAIL' : coverage.partial ? 'PARTIAL' : 'PASS',
      result?.note || coverage.note)
  } catch (error) {
    item.error = error.message
    await saveScreenshot(h.page, shots, 'failure', record).catch(() => {})
    catalogResult(item, definition)
    finishCase(item, caseErrorStatus(error, item.checks), error.message)
  } finally {
    item.durationMs = Date.now() - start
    const trace = path.join(root, 'trace', `${caseId}.zip`)
    fs.mkdirSync(path.dirname(trace), { recursive: true })
    await h.context.tracing.stop({ path: trace }).catch(() => {})
    item.trace = trace
    await h.context.close()
    await h.browser.close()
    await writeReport(record)
  }
  console.log(`[${item.status}] ${caseId} passCandidate=${item.passCandidate}, remaining=${item.remainingAssertions.length}`)
}
const report = await writeReport(record)
console.log(`REPORT ${report.resultFile}`)
process.exitCode = record.cases.some((item) => ['FAIL', 'BLOCKED'].includes(item.status)) ? 1 : 0
