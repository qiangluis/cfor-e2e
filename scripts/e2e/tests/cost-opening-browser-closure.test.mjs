import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COST_OPENING_BROWSER_ASSERTION,
  COST_OPENING_BROWSER_CHECKS,
  COST_OPENING_BROWSER_SOURCE_GAPS,
  CostOpeningBrowserGap,
  costOpeningBrowserReadiness,
  verifyCostOpeningBrowserClosure
} from '../fixtures/cost-opening-browser-closure.mjs'

const clone = (value) => structuredClone(value)
const setup = (change = {}) => {
  const fixture = {
    tenantId: '1', runId: 'unit-run', scenario: 'accounting', suffix: 'ABC123',
    month: '2099-12', versionNo: 'E2E-SC-ACCOUNTING-ABC123',
    periodId: '2109500602170789889', modelId: '2109500602170789888',
    costCenterId: '2109500602170789892',
    remark: 'CFOR-E2E:costScenario:accounting:unit-run:ABC123:tenant=1:org=1:month=2099-12'
  }
  const row = {
    id: '2109500602170789890', periodId: fixture.periodId, materialId: '2109500602170789891',
    stage: 'OPENING', objectKey: 'E2E-COST002-ABC123', remark: fixture.remark,
    sourceType: 'MANUAL', productCode: 'OWN-MAT', costCenterCode: 'E2E-SC-ABC123',
    costCenterName: 'E2E成本场景中心ABC123', status: change.status || 'DRAFT', version: 0,
    quantity: 2, materialAmount: 100, laborAmount: 20, expenseAmount: 10,
    totalAmount: 130, unitCost: 65, confirmedBy: null, lockedBy: null
  }
  const facts = {
    model: { id: fixture.modelId, accountingOrgId: 1, versionNo: fixture.versionNo,
      effectiveMonth: fixture.month, enterpriseType: 'MANUFACTURING',
      status: 'LOCKED', remark: fixture.remark },
    period: { id: fixture.periodId, accountingOrgId: 1, period: fixture.month,
      modelVersionId: fixture.modelId, modelVersionNo: fixture.versionNo,
      enterpriseType: 'MANUFACTURING', status: 'ACCOUNTING', currentPublicationId: null },
    center: { id: fixture.costCenterId, accountingOrgId: 1, code: row.costCenterCode,
      name: row.costCenterName, enabledAt: `${fixture.month}-01`, status: 'ENABLED',
      remark: fixture.remark },
    rows: [row]
  }
  const toSql = (value) => Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
    item == null ? null : String(item)
  ]))
  const centerToSql = (value) => ({
    id: String(value.id),
    accounting_org_id: String(value.accountingOrgId),
    center_code: value.code,
    center_name: value.name,
    status: value.status,
    effective_from: value.enabledAt,
    effective_to: value.disabledAt ?? null,
    remark: value.remark
  })
  const sql = {
    cost_model_version: [{ ...toSql(facts.model), tenant_id: '1', deleted: '0', updater: '1' }],
    cost_period: [{ ...toSql(facts.period), tenant_id: '1', deleted: '0', updater: '1' }],
    cost_center: [{ ...centerToSql(facts.center), tenant_id: '1', deleted: '0', updater: '1' }],
    cost_opening_wip_record: [{ ...toSql(row), tenant_id: '1', deleted: '0', updater: '1' }],
    cost_workspace_state: [{ id: '4', tenant_id: '1', deleted: '0', accounting_org_id: '1',
      state_key: 'shared-model', payload_json: '{"unchanged":true}', version: '7' }]
  }
  const listeners = new Map()
  const log = []
  let handler
  let dialog = false
  let queuedMutation = false
  const state = { facts, sql, fixture, row }
  const api = {
    async getBusiness (path) {
      log.push(['api', path])
      if (change.readFailure) throw new Error('formal GET failed')
      const result = path.includes('opening-wip') ? facts.rows
        : path.includes('model-versions') ? facts.model
          : path.includes('/centers/') ? facts.center : facts.period
      return { code: change.businessFailure ? 500 : 0, data: clone(result) }
    }
  }
  const readSql = async (query) => {
    log.push(['sql', query])
    assert.match(query.trim(), /^SELECT/)
    assert.doesNotMatch(query, /\b(INSERT|UPDATE|DELETE|REPLACE|ALTER)\b/i)
    if (change.sqlUnavailable) return { available: false, rows: [] }
    const metadata = query.includes('information_schema.COLUMNS')
    const table = metadata
      ? query.match(/TABLE_NAME = '([^']+)'/)[1]
      : query.match(/FROM `([^`]+)`/)[1]
    const records = sql[table]
    const columns = Object.keys(records[0])
    if (change.emptyMetadata) return { available: true, rows: [] }
    return { available: true, rows: metadata
      ? columns.map((key) => [key, key === 'deleted' ? 'bit' : 'varchar'])
      : records.map((record) => [JSON.stringify(record)]) }
  }
  const response = () => ({
    url: () => `http://localhost:48083/admin-api/cost/periods/${change.responsePeriod || fixture.periodId}/opening-wip?stage=${change.responseStage || 'OPENING'}`,
    status: () => change.httpStatus || 200,
    request: () => ({ method: () => 'GET', headers: () => ({ 'tenant-id': change.responseTenant || '1' }) }),
    json: async () => ({ code: change.responseCode || 0, data: change.responseRows || clone(facts.rows) })
  })
  const mutation = async (method = 'PUT', pathname = 'workspace-states/save') => handler({
    request: () => ({ url: () => `http://localhost:48083/admin-api/cost/${pathname}`,
      method: () => method }),
    async abort (reason) { log.push(['abort', reason]) },
    async fallback () { assert.fail('mutations must not reach other handlers or server') }
  })
  const page = {
    on (type, listener) { listeners.set(type, listener) },
    off (type, listener) { assert.equal(listeners.get(type), listener); listeners.delete(type) },
    async route (pattern, callback) { assert.equal(pattern, '**/cost/**'); handler = callback },
    async unroute (pattern, callback) {
      assert.equal(pattern, '**/cost/**'); assert.equal(handler, callback); handler = null
    }
  }
  const browserActions = {
    async selectFormalContext ({ phase }) {
      log.push(['select', phase])
      if (change.pageError) throw new Error('page failed')
      if (!change.noResponse) listeners.get('response')(response())
      if (change.consoleError) listeners.get('console')({ type: () => 'error' })
      if (change.emittedPageError) listeners.get('pageerror')(new Error('uncaught page exception'))
      if (change.requestFailed) listeners.get('requestfailed')({
        url: () => `http://localhost:48083/admin-api/cost/periods/${fixture.periodId}/opening-wip`
      })
      if (change.attemptMutation) await mutation(change.mutationMethod, change.mutationPath)
    },
    async observeFormalRow ({ phase }) {
      const value = {
        modelId: fixture.modelId, versionNo: fixture.versionNo, month: fixture.month,
        periodId: fixture.periodId, stage: 'OPENING', matchedRowCount: 1,
        row: { ...clone(row), backendId: row.id,
          statusText: row.status === 'REVERSED' ? '首次期间已回退至试算' : '草稿' }
      }
      return change.observe ? change.observe(value, phase, state) : value
    },
    async editDraft ({ draft }) {
      log.push(['draft', clone(draft)])
      dialog = true
      queuedMutation = change.delayedMutation === true
      change.onEdit?.(state)
      return { dialogVisible: true, quantity: draft.quantity, remark: draft.remark,
        ...(change.draftObservation || {}) }
    },
    async cancelDraft () { log.push(['cancel']); dialog = false; change.onCancel?.(state) },
    async refresh () { log.push(['refresh']); dialog = false; change.onRefresh?.(state) },
    async dialogVisible () { return change.dialogRemains || dialog },
    async flushUiTasks () {
      if (queuedMutation) {
        queuedMutation = false
        await mutation()
      }
    }
  }
  return {
    api, page, fixture, openingRow: clone(row),
    record: { runId: 'unit-run', environment: { target: 'local', tenantId: '1' } },
    caseRecord: { id: 'COST-002', checks: [], notes: [] },
    dependencies: { readSql, browserActions },
    state, listeners, log, hasHandler: () => Boolean(handler)
  }
}

test('owned DRAFT uses real-response-shaped evidence across cancel/refresh and never writes', async () => {
  const input = setup()
  const evidence = await verifyCostOpeningBrowserClosure(input)
  assert.equal(evidence.assertion, COST_OPENING_BROWSER_ASSERTION)
  assert.equal(evidence.assertionIndex, 5)
  assert.deepEqual(input.caseRecord.checks.map((entry) => entry.name),
    Object.values(COST_OPENING_BROWSER_CHECKS))
  assert.ok(input.caseRecord.checks.every((entry) => entry.passed === true))
  assert.deepEqual(evidence.phases.map((entry) => entry.name), ['formal', 'cancel', 'refresh'])
  assert.equal(evidence.phases.at(-1).formalReads, 2)
  assert.deepEqual(evidence.attemptedMutations, [])
  assert.equal(input.listeners.size, 0)
  assert.equal(input.hasHandler(), false)
  assert.equal(input.log.filter(([kind]) => kind === 'draft').length, 2)
  assert.ok(input.log.filter(([kind]) => kind === 'sql').every(([, sql]) => /^\s*SELECT/.test(sql)))
})

test('REVERSED is genuinely re-read and supports an unsubmitted new-form draft', async () => {
  const input = setup({ status: 'REVERSED' })
  await verifyCostOpeningBrowserClosure(input)
  assert.ok(input.caseRecord.checks.every((entry) => entry.passed))
})

test('missing center and browser adapters remain a GAP without attempting navigation', async () => {
  const input = setup()
  delete input.dependencies.browserActions
  delete input.state.facts.rows[0].costCenterCode
  delete input.state.facts.rows[0].costCenterName
  delete input.openingRow.costCenterCode
  delete input.openingRow.costCenterName
  input.state.sql.cost_opening_wip_record[0].cost_center_code = null
  input.state.sql.cost_opening_wip_record[0].cost_center_name = null
  await assert.rejects(() => verifyCostOpeningBrowserClosure(input), (error) => {
    assert.ok(error instanceof CostOpeningBrowserGap)
    assert.ok(error.gaps.some((gap) => gap.includes('costCenterCode')))
    assert.ok(COST_OPENING_BROWSER_SOURCE_GAPS.every((gap) => error.gaps.includes(gap)))
    return true
  })
  assert.equal(input.caseRecord.checks.length, 0)
  assert.equal(input.hasHandler(), false)
  assert.equal(input.log.some(([kind]) => kind === 'select'), false)
})

for (const status of ['CONFIRMED', 'LOCKED']) {
  test(`${status} cannot be used as an editable draft fixture`, async () => {
    const input = setup({ status })
    await assert.rejects(() => verifyCostOpeningBrowserClosure(input), CostOpeningBrowserGap)
    assert.equal(input.hasHandler(), false)
  })
}

for (const [label, change, message] of [
  ['API transport failure', { readFailure: true }, /formal GET failed/],
  ['business failure', { businessFailure: true }, /正式 API 读取失败/],
  ['SQL unavailable', { sqlUnavailable: true }, /SQL 证据不可用/],
  ['missing full-field metadata', { emptyMetadata: true }, /字段元数据无效/],
  ['browser HTTP failure', { httpStatus: 500 }, /HTTP 异常/],
  ['browser business failure', { responseCode: 422001 }, /正式 API 读取失败/],
  ['missing response', { noResponse: true }, /缺少本阶段真实浏览器/],
  ['wrong browser period', { responsePeriod: '900' }, /期间、阶段或租户不精确/],
  ['wrong browser stage', { responseStage: 'CARRYOVER' }, /期间、阶段或租户不精确/],
  ['wrong browser tenant', { responseTenant: '2' }, /期间、阶段或租户不精确/],
  ['empty response rows', { responseRows: [] }, /完整 API 基线不一致/],
  ['page operation failure', { pageError: true }, /page failed/],
  ['console exception', { consoleError: true }, /控制台 error/],
  ['uncaught page exception', { emittedPageError: true }, /uncaught page exception/],
  ['failed browser request', { requestFailed: true }, /成本请求失败/],
  ['dialog not discarded', { dialogRemains: true }, /表单仍存在/],
  ['unobserved draft values', { draftObservation: { quantity: 2 } }, /实际填写并观测/],
  ['coerced boolean draft evidence', { draftObservation: { dialogVisible: 'true' } }, /实际填写并观测/],
  ['attempted shared PUT', { attemptMutation: true }, /发现成本写请求/],
  ['delayed workspace autosave', { delayedMutation: true }, /发现成本写请求/]
]) {
  test(`${label} is not downgraded to a successful browser boundary`, async () => {
    const input = setup(change)
    await assert.rejects(() => verifyCostOpeningBrowserClosure(input), message)
    assert.equal(input.hasHandler(), false)
    assert.equal(input.listeners.size, 0)
    assert.ok(!input.caseRecord.checks.length ||
      input.caseRecord.checks.some((entry) => entry.passed === false))
    if (change.attemptMutation) {
      assert.equal(input.log.filter(([kind]) => kind === 'abort').length, 1)
      assert.ok(input.caseRecord.costOpeningBrowserEvidence.final,
        'an aborted browser mutation still needs independent final API/SQL readback')
    }
  })
}

for (const [field, value] of [
  ['modelId', '900'], ['periodId', '900'], ['month', '2099-11'], ['stage', 'CARRYOVER']
]) {
  test(`wrong page ${field} fails even with a correct formal response`, async () => {
    const input = setup({ observe: (observation) => ({ ...observation, [field]: value }) })
    await assert.rejects(() => verifyCostOpeningBrowserClosure(input), /页面正式模型/)
  })
}

for (const [field, value] of [
  ['backendId', '2109500602170789892'], ['backendId', 2109500602170789890],
  ['materialId', '900'], ['totalAmount', 131], ['quantity', null], ['statusText', '已锁死']
]) {
  test(`page row ${field}=${value} cannot pass via product-code-only matching`, async () => {
    const input = setup({ observe: (observation) => ({
      ...observation, row: { ...observation.row, [field]: value }
    }) })
    await assert.rejects(() => verifyCostOpeningBrowserClosure(input), /页面/)
  })
}

for (const [label, change] of [
  ['draft-time workspace autosave', { onEdit: ({ sql }) => { sql.cost_workspace_state[0].version = '8' } }],
  ['cancel changed formal audit', { onCancel: ({ sql }) => { sql.cost_opening_wip_record[0].updater = '2' } }],
  ['refresh changed API field', { onRefresh: ({ facts }) => { facts.rows[0].lockedBy = '2' } }],
  ['refresh changed nullable SQL field', { onRefresh: ({ sql }) => {
    sql.cost_opening_wip_record[0].locked_by = '2'
  } }],
  ['refresh created workspace row', { onRefresh: ({ sql }) => {
    sql.cost_workspace_state.push({ ...sql.cost_workspace_state[0], id: '99' })
  } }]
]) {
  test(`${label} fails complete fact comparison`, async () => {
    const input = setup(change)
    await assert.rejects(() => verifyCostOpeningBrowserClosure(input), /改变|不一致|不变性失败/)
    assert.equal(input.caseRecord.checks.at(-1).name, COST_OPENING_BROWSER_CHECKS.boundary)
    assert.equal(input.caseRecord.checks.at(-1).passed, false)
  })
}

test('foreign fixture fails before API/SQL/browser operations', async () => {
  const input = setup()
  input.fixture.runId = 'another-run'
  await assert.rejects(() => verifyCostOpeningBrowserClosure(input), /本轮租户/)
  assert.equal(input.log.length, 0)
})

test('non-local target fails before all reads or browser operations', async () => {
  const input = setup()
  input.record.environment.target = 'online'
  await assert.rejects(() => verifyCostOpeningBrowserClosure(input), /本轮租户/)
  assert.equal(input.log.length, 0)
})

test('an owned marker cannot legitimize another cost center', async () => {
  const input = setup()
  input.state.facts.rows[0].costCenterCode = 'SHARED'
  input.openingRow.costCenterCode = 'SHARED'
  await assert.rejects(() => verifyCostOpeningBrowserClosure(input), /不是本轮专属中心/)
  assert.equal(input.hasHandler(), false)
})

for (const variant of ['missingColumn', 'duplicateColumn', 'wrongTenant', 'duplicateRow']) {
  test(`SQL ${variant} cannot be accepted as a complete immutable snapshot`, async () => {
    const input = setup()
    const read = input.dependencies.readSql
    input.dependencies.readSql = async (query) => {
      const result = await read(query)
      if (!query.includes('cost_opening_wip_record')) return result
      if (query.includes('information_schema')) {
        if (variant === 'duplicateColumn') result.rows.push(clone(result.rows[0]))
        return result
      }
      const row = JSON.parse(result.rows[0][0])
      if (variant === 'missingColumn') delete row.updater
      if (variant === 'wrongTenant') row.tenant_id = '2'
      result.rows[0][0] = JSON.stringify(row)
      if (variant === 'duplicateRow') result.rows.push(clone(result.rows[0]))
      return result
    }
    await assert.rejects(() => verifyCostOpeningBrowserClosure(input),
      /字段元数据无效|完整行缺字段或租户漂移|重复 ID/)
    assert.equal(input.hasHandler(), false)
  })
}

test('readiness never treats arbitrary truthy adapters or unknown status as proof', () => {
  const input = setup()
  const readiness = costOpeningBrowserReadiness(input.fixture, { status: 'UNKNOWN' }, {
    selectFormalContext: true, observeFormalRow: 'true'
  })
  assert.equal(readiness.ready, false)
  assert.equal(readiness.gaps.length, COST_OPENING_BROWSER_SOURCE_GAPS.length + 2)
  assert.ok(COST_OPENING_BROWSER_SOURCE_GAPS.every((gap) => readiness.gaps.includes(gap)))
})

test('ambiguous page rows cannot pass via the first matching product code', async () => {
  const input = setup({ observe: (observation) => ({ ...observation, matchedRowCount: 2 }) })
  await assert.rejects(() => verifyCostOpeningBrowserClosure(input), /页面正式行/)
})

for (const [method, pathname] of [
  ['PUT', 'periods/2109500602170789889/opening-wip'],
  ['POST', 'periods/2109500602170789889/publications'],
  ['POST', 'model-versions/2109500602170789888/lock'],
  ['DELETE', 'model-versions/2109500602170789888']
]) {
  test(`browser ${method} ${pathname} is aborted rather than fulfilled with a false success`, async () => {
    const input = setup({ attemptMutation: true, mutationMethod: method, mutationPath: pathname })
    await assert.rejects(() => verifyCostOpeningBrowserClosure(input), /发现成本写请求/)
    assert.equal(input.log.filter(([kind]) => kind === 'abort').length, 1)
  })
}

test('default UI actions edit only known unsaved form fields, cancel and reload without save', async () => {
  const input = setup()
  for (const method of ['editDraft', 'cancelDraft', 'refresh', 'dialogVisible', 'flushUiTasks']) {
    delete input.dependencies.browserActions[method]
  }
  let visible = false
  let quantityValue = '1'
  let remarkValue = ''
  const field = (kind) => ({
    async count () { return 1 },
    async inputValue () { return kind === 'quantity' ? quantityValue : remarkValue },
    async fill (value) {
      if (kind === 'quantity') quantityValue = value
      else remarkValue = value
      input.log.push(['fill', kind, value])
    },
    async press (key) { assert.equal(key, 'Tab') }
  })
  input.page.locator = (selector) => {
    if (selector === '.opening-wip-workspace') return {
      getByRole (role, options) {
        assert.equal(role, 'button')
        assert.deepEqual(options, { name: '手工新增', exact: true })
        return {
          async count () { return 1 },
          async isEnabled () { return true },
          async click () { visible = true; quantityValue = '1'; remarkValue = '' }
        }
      }
    }
    assert.equal(selector, '.el-dialog:has(.opening-wip-form):visible')
    return {
      async count () { return visible ? 1 : 0 },
      async isVisible () { return visible },
      async waitFor ({ state }) { assert.equal(visible, state === 'visible') },
      locator (itemSelector) {
        assert.equal(itemSelector, '.el-form-item')
        return {
          filter ({ hasText }) {
            assert.ok(['期初数量', '备注'].includes(hasText))
            return { locator (inputSelector) {
              assert.equal(inputSelector, hasText === '期初数量' ? 'input' : 'input, textarea')
              return field(hasText === '期初数量' ? 'quantity' : 'remark')
            } }
          }
        }
      },
      getByRole (role, options) {
        assert.equal(role, 'button')
        assert.deepEqual(options, { name: '取消', exact: true })
        return { async click () { visible = false } }
      }
    }
  }
  input.page.reload = async (options) => {
    assert.deepEqual(options, { waitUntil: 'domcontentloaded' })
    visible = false
  }
  input.page.waitForTimeout = async (ms) => {
    assert.equal(ms, 750)
    input.log.push(['flush', ms])
  }
  await verifyCostOpeningBrowserClosure(input)
  assert.equal(input.log.filter(([kind]) => kind === 'fill').length, 4)
  assert.ok(input.log.filter(([kind]) => kind === 'flush').length >= 6)
  assert.ok(input.caseRecord.checks.every((entry) => entry.passed))
})
