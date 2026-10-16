import { createApiClient } from './lib/api.mjs'
import { launchBrowser, login } from './lib/browser.mjs'
import { createRunRecord, createCaseRecord, finishCase, writeReport } from './lib/report.mjs'
import { ensureAcceptanceNumbering } from './fixtures/acceptance-numbering.mjs'

const codes = process.argv.slice(2)
const record = createRunRecord({ selectedCases: ['PREP-ACCEPTANCE-NUMBER'] })
const caseRecord = createCaseRecord({
  id: 'PREP-ACCEPTANCE-NUMBER', suite: 'preparation', title: '本地测试租户缺失编号前置'
})
record.cases.push(caseRecord)
let handle
try {
  handle = await launchBrowser({ record })
  const api = createApiClient({ token: await login(handle.page), record })
  await ensureAcceptanceNumbering(api, caseRecord, codes.length ? codes : ['fin_yshx_bill_no', 'batch_no'])
  finishCase(caseRecord, 'PASS')
} catch (error) {
  finishCase(caseRecord, 'FAIL', error.message)
} finally {
  await handle?.browser.close()
}
const report = await writeReport(record)
console.log(`[${caseRecord.status}] PREP-ACCEPTANCE-NUMBER report=${report.resultFile}`)
process.exitCode = record.passed ? 0 : 1
