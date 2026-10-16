import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const suiteSource = fs.readFileSync(
  new URL('../suites/procurement.mjs', import.meta.url), 'utf8'
)
const branch = suiteSource.slice(
  suiteSource.indexOf("if (caseId === 'PROC-014')"),
  suiteSource.indexOf("if (caseId === 'PROC-015')")
)

test('PROC-014 prepares formal approval before the independent closed-line order rejection', () => {
  const approvedPrecondition = branch.indexOf('approvePurchaseRequestForClosure')
  const firstClose = branch.indexOf('const afterOne = await closeVisibleLine()')
  const rejection = branch.indexOf('已审核且仅一行关闭的请购正式下单被关闭分录门禁拒绝，数据不变')
  assert.ok(approvedPrecondition >= 0)
  assert.ok(firstClose > approvedPrecondition)
  assert.ok(rejection > firstClose)
  assert.match(branch, /message: \/存在已关闭的请购分录，无法生成采购订单\//)
})

test('PROC-014 keeps the negative probe read-only after the formal API rejection', () => {
  const rejection = branch.slice(branch.indexOf('const rejectedOrder = await api.put('))
  assert.match(rejection, /afterRejectedOrder = await fixture\.read\(\)/)
  assert.match(rejection, /after-approved-closed-line-order-rejection/)
  assert.match(rejection, /firstLineSourceOrdersBefore\.rows\)/)
  assert.match(rejection, /firstLineSourceOrdersAfter\.rows\)/)
  assert.match(rejection, /JSON\.stringify\(afterRejectedOrder\) === JSON\.stringify\(afterOne\)/)
})

test('PROC-014 repeated close preserves the approved request instead of expecting a draft order flag', () => {
  const repeated = branch.slice(
    branch.indexOf('const beforeRepeatedClose ='),
    branch.indexOf('const [closedQuery]')
  )
  assert.match(repeated, /before-repeat-whole-close/)
  assert.match(repeated, /repeated\.code === 500/)
  assert.match(repeated, /JSON\.stringify\(afterRepeatedClose\) === JSON\.stringify\(afterAll\)/)
  assert.match(repeated, /JSON\.stringify\(after\) === JSON\.stringify\(beforeRepeatedClose\)/)
  assert.doesNotMatch(repeated, /row\[0\] === 'bill'\)\?\.\[3\]\) === 0/)
  assert.match(branch, /3: \['整单重复关闭明确拒绝，既有下单标志、数量及审计不变'\]/)
})

test('PROC-014 approval cleanup drains and closes pages before invalidating their tokens', () => {
  const approval = suiteSource.slice(
    suiteSource.indexOf('const approvePurchaseRequestForClosure ='),
    suiteSource.indexOf('const resolveProcurementTenantContext =')
  )
  const cleanup = approval.slice(approval.indexOf('const cleanupErrors = []'))
  const drain = cleanup.indexOf('await browser.flushResponses()')
  const close = cleanup.indexOf('await browser.browser.close()')
  const logout = cleanup.indexOf("await resource.logoutApi.postBusiness('/system/auth/logout')")
  assert.ok(drain >= 0 && close > drain && logout > close)
  assert.match(cleanup, /审批页面响应检查失败/)
  assert.match(cleanup, /审批浏览器关闭失败/)
  assert.match(cleanup, /failure = failure/)
})

test('PROC-014 uses an opted-in real tenant fixture but does not claim organization matrix coverage', () => {
  assert.match(branch, /process\.env\.CFOR_E2E_WRITE_FIXTURES === 'true'/)
  assert.match(branch, /await verifyProcurementTenantIsolation/)
  assert.match(branch, /JSON\.stringify\(afterIsolation\) === JSON\.stringify\(initialRequest\)/)
  assert.match(branch, /JSON\.stringify\(afterIsolationSnapshot\) === JSON\.stringify\(before\)/)
  assert.match(branch, /组织矩阵仍待补验/)
  assert.doesNotMatch(branch, /createTenant|tenant\/create|system\/tenant\/create/)
})
