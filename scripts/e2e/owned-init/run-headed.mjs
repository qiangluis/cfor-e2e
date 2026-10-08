import { chromium } from 'playwright-core'
import { config, resolveChromePath } from '../config/index.mjs'
import { assertLocalWriteSafety } from '../lib/db.mjs'
import { createCaseRecord, createRunRecord, finishCase, writeReport } from '../lib/report.mjs'
import { launchBrowser, login } from '../lib/browser.mjs'
import { createApiClient } from '../lib/api.mjs'
import { runOwnedInitCase } from './fixtures.mjs'
import { ownedInitCases } from './fixtures.mjs'

const selected = process.argv.slice(2).filter((value) => !value.startsWith('--'))
const cases = selected.length ? selected : ownedInitCases
if (cases.some((caseId) => !ownedInitCases.includes(caseId))) {
  throw new Error(`Only owned init cases are allowed: ${ownedInitCases.join(', ')}`)
}
if (config.target !== 'local' || String(config.tenantId) !== '1' ||
    config.tenantName !== 'CFOR 标准平台' || config.db.name !== 'cfor_admin_standard') {
  throw new Error('BLOCKED: owned headed runner requires tenant1 local scope')
}

const headed = process.env.CFOR_E2E_HEADLESS === 'false' || process.env.CFOR_E2E_HEADLESS === '0'
if (!headed) throw new Error('BLOCKED: owned headed runner requires CFOR_E2E_HEADLESS=false')

const record = createRunRecord({ selectedSuites: ['owned-init'], selectedCases: cases })
const browserHandle = await launchBrowser({ headed: true, record })
try {
  await browserHandle.context.tracing.start({ screenshots: true, snapshots: true, sources: false })
  for (const caseId of cases) {
    const definition = { id: caseId, suite: 'owned-init', title: caseId }
    const caseRecord = createCaseRecord(definition)
    record.cases.push(caseRecord)
    const context = {
      caseId,
      suiteId: 'owned-init',
      page: browserHandle.page,
      context: browserHandle.context,
      record,
      caseRecord,
      outputDir: `${config.outputRoot}/${record.runId}/screenshots`,
      check: { step: () => {} }
    }
    try {
      const auth = await login(browserHandle.page, { returnContext: true })
      const api = createApiClient({ token: auth.token, tenantId: '1', record })
      await runOwnedInitCase(context, {
        config,
        login: async () => auth,
        createApiClient: () => api,
        assertLocalWriteSafety
      })
      finishCase(caseRecord, 'PASS', 'owned headed steps completed')
    } catch (error) {
      finishCase(caseRecord, String(error.message).startsWith('BLOCKED:') ? 'BLOCKED' : 'FAIL', error.message)
    }
  }
} finally {
  await browserHandle.flushResponses().catch(() => {})
  await browserHandle.context.tracing.stop().catch(() => {})
  await browserHandle.browser.close()
}
const report = await writeReport(record)
console.log(JSON.stringify({ outputDir: report.outputDir, resultFile: report.resultFile, cases: record.cases.map(({ id, status, notes }) => ({ id, status, notes })) }))
