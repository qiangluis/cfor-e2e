#!/usr/bin/env node

import { runCase } from './suites/print-template.mjs'
import { createCaseRecord, createRunRecord, finishCase, writeReport } from './lib/report.mjs'
import { launchBrowser } from './lib/browser.mjs'
import { config } from './config/index.mjs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const caseId = 'PB010-001'
const record = createRunRecord({ selectedSuites: ['print-template'], selectedCases: [caseId] })
const outputDir = path.join(config.outputRoot, record.runId, 'screenshots')
await mkdir(outputDir, { recursive: true })
const browser = await launchBrowser({ headed: process.argv.includes('--headed'), record })
const caseRecord = createCaseRecord({
  id: caseId,
  suite: 'print-template',
  title: '打印模板租户隔离、版本发布、绑定优先级与锁版治理',
  status: 'PARTIAL'
})
record.cases.push(caseRecord)

let browserHandle
try {
  browserHandle = await launchBrowser({ headed: process.argv.includes('--headed'), record })
  await browserHandle.context.tracing.start({ screenshots: true, snapshots: true, sources: false })
  await runCase({
    caseId,
    page: browserHandle.page,
    context: browserHandle.context,
    record,
    caseRecord,
    outputDir
  })
  const failedChecks = caseRecord.checks.filter((check) => !check.passed)
  finishCase(
    caseRecord,
    failedChecks.length === 0 ? 'PASS' : 'FAIL',
    failedChecks.length === 0
      ? ''
      : `失败断言：${failedChecks.map((check) => check.name).join('、')}`
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
