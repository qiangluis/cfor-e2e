#!/usr/bin/env node

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { config } from './config/index.mjs'
import { launchBrowser } from './lib/browser.mjs'
import { createCaseRecord, createRunRecord, finishCase, writeReport } from './lib/report.mjs'
import { runCase } from './suites/after-sales-inspection-config.mjs'

const record = createRunRecord({
  selectedSuites: ['after-sales-inspection-config'],
  selectedCases: ['PB122-001']
})
const caseRecord = createCaseRecord({
  id: 'PB122-001',
  suite: 'after-sales-inspection-config',
  title: '售后巡检项目、版本化方案、资产分配与现有任务复用'
})
record.cases.push(caseRecord)

const outputDir = path.join(config.outputRoot, record.runId, 'screenshots')
await mkdir(outputDir, { recursive: true })
let browserHandle

try {
  browserHandle = await launchBrowser({ record })
  await browserHandle.context.tracing.start({ screenshots: true, snapshots: true, sources: false })
  await runCase({ page: browserHandle.page, record, caseRecord, outputDir })
  const failedChecks = caseRecord.checks.filter((check) => !check.passed)
  finishCase(
    caseRecord,
    failedChecks.length === 0 ? 'PASS' : 'FAIL',
    failedChecks.length === 0 ? '' : `失败断言：${failedChecks.map((check) => check.name).join('、')}`
  )
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  finishCase(caseRecord, message.startsWith('BLOCKED:') ? 'BLOCKED' : 'FAIL', message)
} finally {
  if (browserHandle) {
    const tracePath = path.join(config.outputRoot, record.runId, 'trace', 'browser.zip')
    await mkdir(path.dirname(tracePath), { recursive: true })
    await browserHandle.context.tracing.stop({ path: tracePath }).catch(() => {})
    await browserHandle.context.close().catch(() => {})
    await browserHandle.browser.close().catch(() => {})
  }
}

const report = await writeReport(record)
console.log(`Result: ${record.passed ? 'PASS' : 'PARTIAL/FAIL'}`)
console.log(`Report: ${report.resultFile}`)
process.exit(record.passed ? 0 : 1)
