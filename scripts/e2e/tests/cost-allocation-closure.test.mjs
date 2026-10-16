import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import {
  COST_ALLOCATION_BASE_MODES,
  COST_ALLOCATION_CLOSURE_CHECKS,
  COST_ALLOCATION_FACTOR_MODES,
  COST_ALLOCATION_INVALID_MODE,
  COST_ALLOCATION_MODES,
  __internal,
  allocationModeEvidence,
  chooseFutureCostMonth,
  cleanupCostAllocationClosureFixture,
  createCostAllocationClosureFixture,
  readSharedCostWorkspaceSnapshot,
  runCostAllocationClosure,
  verifyBrowserDraftBoundaries,
  verifyCostSharedWorkspaceBoundary,
  verifyInvalidAllocationMode
} from '../fixtures/cost-allocation-closure.mjs'
import { matchesExpectedBusinessRejection } from '../lib/api.mjs'

const ok = (data) => ({ code: 0, data })

const makeRecord = () => ({
  runId: '20261012-cost-closure-unit',
  environment: { tenantId: '1' },
  api: []
})

const makeCaseRecord = () => ({
  id: 'COST-001',
  caseId: 'COST-001',
  checks: [],
  evidence: [],
  notes: []
})

const makeApi = ({ failDepartmentDelete = false, invalidResponse } = {}) => {
  let next = 9223372036854775000n
  const state = {
    departments: new Map(),
    centers: new Map(),
    models: new Map(),
    components: new Map(),
    rules: new Map(),
    deletedDepartments: [],
    allocationModes: []
  }
  const id = () => String(next++)
  const api = {
    state,
    async getBusiness (pathname) {
      const url = new URL(pathname, 'http://unit.test')
      if (url.pathname === '/cost/model-versions' && url.searchParams.has('pageNo')) {
        return ok({ list: [...state.models.values()], total: state.models.size })
      }
      if (url.pathname === '/cost/periods') return ok({ list: [], total: 0 })
      if (url.pathname === '/system/dept/get') return ok(state.departments.get(url.searchParams.get('id')))
      if (url.pathname === '/cost/centers') {
        return ok([...state.centers.values()])
      }
      if (url.pathname.startsWith('/cost/centers/')) {
        return ok(state.centers.get(url.pathname.split('/').at(-1)))
      }
      if (url.pathname.startsWith('/cost/model-versions/') &&
          url.pathname.endsWith('/components')) {
        return ok(state.components.get(url.pathname.split('/')[3]))
      }
      if (url.pathname.startsWith('/cost/model-versions/')) {
        return ok(state.models.get(url.pathname.split('/').at(-1)))
      }
      if (url.pathname === '/cost/allocation-rules') {
        return ok([...state.rules.values()].filter((row) =>
          row.modelVersionId === url.searchParams.get('modelVersionId') &&
          row.effectiveMonth === url.searchParams.get('effectiveMonth')
        ))
      }
      throw new Error(`unexpected GET ${pathname}`)
    },
    async postBusiness (pathname, body) {
      if (pathname === '/system/dept/create') {
        const record = { ...body, id: id(), parentId: body.parentId ?? 0 }
        state.departments.set(record.id, record)
        return ok(record.id)
      }
      if (pathname === '/cost/centers') {
        const record = { ...body, id: id(), status: 'ENABLED', disabledAt: null, referenceCount: 0 }
        state.centers.set(record.id, record)
        return ok(record)
      }
      if (pathname.startsWith('/cost/centers/') && pathname.endsWith('/deactivate')) {
        const centerId = pathname.split('/').at(-2)
        const current = state.centers.get(centerId)
        state.centers.set(centerId, {
          ...current,
          status: 'DISABLED',
          disabledAt: body.disabledAt
        })
        return ok(state.centers.get(centerId))
      }
      if (pathname === '/cost/model-versions') {
        const record = {
          ...body,
          id: id(),
          status: 'DRAFT',
          accountingOrgId: Number(body.accountingOrgId)
        }
        state.models.set(record.id, record)
        return ok(record)
      }
      throw new Error(`unexpected POST ${pathname}`)
    },
    async putBusiness (pathname, body) {
      if (pathname.endsWith('/components')) {
        const modelId = pathname.split('/')[3]
        const category = {
          id: id(),
          parentId: '',
          code: body.categories[0].code,
          name: body.categories[0].name,
          status: 'ENABLED'
        }
        const item = {
          id: id(),
          categoryId: category.id,
          code: body.items[0].code,
          name: body.items[0].name,
          systemItem: false,
          status: 'ENABLED',
          remark: body.items[0].remark
        }
        const source = {
          id: id(),
          componentItemId: item.id,
          sourceType: body.sourceRules[0].sourceType,
          status: 'ENABLED'
        }
        const config = { modelVersionId: modelId, categories: [category], items: [item], sourceRules: [source] }
        state.components.set(modelId, config)
        return ok(config)
      }
      if (pathname === '/cost/allocation-rules') {
        state.allocationModes.push(body.lines[0].allocationMode)
        const record = {
          ...body,
          id: id(),
          modelVersionId: String(body.modelVersionId),
          costCenterId: String(body.costCenterId),
          effectiveMonth: body.effectiveMonth,
          lines: body.lines.map((line) => ({ ...line, id: id(), componentItemId: String(line.componentItemId) }))
        }
        state.rules.set(`${record.modelVersionId}:${record.costCenterId}:${record.effectiveMonth}`, record)
        return ok(record)
      }
      throw new Error(`unexpected PUT-BUSINESS ${pathname}`)
    },
    async put (pathname, body) {
      if (pathname === '/cost/allocation-rules' && body.lines?.[0]?.allocationMode === 'UNKNOWN_FACTOR') {
        return invalidResponse || {
          code: COST_ALLOCATION_INVALID_MODE.code,
          msg: COST_ALLOCATION_INVALID_MODE.message,
          data: null
        }
      }
      throw new Error(`unexpected raw PUT ${pathname}`)
    },
    async deleteBusiness (pathname) {
      if (failDepartmentDelete) throw new Error('模拟部门删除失败')
      const departmentId = new URL(pathname, 'http://unit.test').searchParams.get('id')
      state.departments.delete(departmentId)
      state.deletedDepartments.push(departmentId)
      return ok(true)
    },
    async request (method, pathname) {
      const idValue = new URL(pathname, 'http://unit.test').searchParams.get('id')
      return method === 'GET' && state.departments.has(idValue)
        ? ok(state.departments.get(idValue))
        : ok(null)
    }
  }
  return api
}

const fakeBrowser = {
  async open () {},
  async assertDedicatedRows () {},
  async assertFormalValues () {},
  async verifyModeControls () { return [1280, 1600, 1920] },
  async editDraft () {},
  async cancelDraft () { return 'button' },
  async refresh () {}
}

test('future month selector excludes all existing model and period months', () => {
  const month = chooseFutureCostMonth({
    models: [{ effectiveMonth: '2028-10' }, { effectiveMonth: '2028-11' }],
    periods: [{ period: '2028-12' }],
    now: new Date('2026-10-12T00:00:00Z')
  })
  assert.equal(month, '2029-01')
  assert.ok(month > '2026-10')
})

test('formal payloads preserve exact registered IDs and never coerce them to Number', () => {
  const fixture = {
    suffix: 'ABC123',
    marker: 'CFOR-E2E:COST-001:run:ABC123:tenant=1:org=1:month=2099-01',
    effectiveMonth: '2099-01',
    accountingOrgId: '1',
    modelVersionId: '9223372036854775001',
    costCenterId: '9223372036854775002',
    componentItemId: '9223372036854775003'
  }
  const model = __internal.modelPayload(fixture)
  const rule = __internal.validRulePayload(fixture)
  assert.equal(typeof rule.modelVersionId, 'string')
  assert.equal(typeof rule.costCenterId, 'string')
  assert.equal(typeof rule.lines[0].componentItemId, 'string')
  assert.equal(model.effectiveMonth, '2099-01')
  assert.equal(model.remark, fixture.marker)
})

test('exact invalid allocation mode rejection never counts generic service failure', () => {
  assert.equal(matchesExpectedBusinessRejection({
    code: 422001,
    msg: 'unsupported allocation mode',
    data: null
  }, COST_ALLOCATION_INVALID_MODE), true)
  assert.equal(matchesExpectedBusinessRejection({
    code: 500,
    msg: 'unsupported allocation mode',
    data: null
  }, COST_ALLOCATION_INVALID_MODE), false)
  assert.equal(matchesExpectedBusinessRejection({
    code: 422001,
    msg: '系统异常',
    data: null
  }, COST_ALLOCATION_INVALID_MODE), false)
})

test('allocation mode evidence keeps the seven backend enum values separate from COST-001 three-mode scope', () => {
  const evidence = allocationModeEvidence({
    savedModes: ['QUANTITY', 'AMOUNT', 'MANUAL'],
    finalMode: 'QUANTITY'
  })
  assert.deepEqual(evidence.supportedModes, [
    'QUANTITY', 'AMOUNT', 'MANUAL', 'LABOR_HOUR',
    'MACHINE_HOUR', 'AREA', 'OUTPUT'
  ])
  assert.deepEqual(evidence.acceptanceModes, [...COST_ALLOCATION_BASE_MODES])
  assert.deepEqual(evidence.factorModes, [...COST_ALLOCATION_FACTOR_MODES])
  assert.deepEqual(evidence.observedModes, [...COST_ALLOCATION_BASE_MODES])
  assert.equal(evidence.allAcceptanceModesObserved, true)
  assert.equal(evidence.finalMode, 'QUANTITY')
  assert.deepEqual(COST_ALLOCATION_MODES, [
    ...COST_ALLOCATION_BASE_MODES, ...COST_ALLOCATION_FACTOR_MODES
  ])
})

test('COST-001 full closure creates and rereads dedicated formal objects, rejects invalid mode, and leaves audit objects explicit', async () => {
  const api = makeApi()
  const record = makeRecord()
  const caseRecord = makeCaseRecord()
  const result = await runCostAllocationClosure({
    api,
    page: {},
    record,
    caseRecord,
    dependencies: {
      config: { target: 'local', tenantId: '1' },
      assertLocalWriteSafety: async () => {},
      browserActions: fakeBrowser
    }
  })
  assert.ok(result.modelVersionId)
  assert.ok(result.costCenterId)
  assert.ok(result.componentItemId)
  assert.ok(result.ruleId)
  assert.equal(caseRecord.checks.every((check) => check.passed), true)
  assert.deepEqual(caseRecord.checks.map((check) => check.name), [
    COST_ALLOCATION_CLOSURE_CHECKS.modes,
    COST_ALLOCATION_CLOSURE_CHECKS.fixture,
    COST_ALLOCATION_CLOSURE_CHECKS.saveReadback,
    COST_ALLOCATION_CLOSURE_CHECKS.invalidMode,
    COST_ALLOCATION_CLOSURE_CHECKS.browserRoute,
    COST_ALLOCATION_CLOSURE_CHECKS.browserCancel,
    COST_ALLOCATION_CLOSURE_CHECKS.browserRefresh,
    COST_ALLOCATION_CLOSURE_CHECKS.browserModes,
    COST_ALLOCATION_CLOSURE_CHECKS.cleanup
  ])
  assert.deepEqual(api.state.deletedDepartments, [result.departmentId])
  assert.equal(api.state.centers.get(result.costCenterId).status, 'DISABLED')
  assert.ok(api.state.models.has(result.modelVersionId))
  assert.ok(api.state.rules.has(`${result.modelVersionId}:${result.costCenterId}:${result.effectiveMonth}`))
  assert.deepEqual(api.state.allocationModes, [
    'QUANTITY', 'AMOUNT', 'MANUAL', 'QUANTITY'
  ])
  assert.deepEqual(result.modeEvidence.acceptanceModes, [...COST_ALLOCATION_BASE_MODES])
  assert.equal(result.modeEvidence.allAcceptanceModesObserved, true)
  assert.deepEqual(result.modeEvidence.observedModes, [...COST_ALLOCATION_BASE_MODES])
})

test('COST-001 rejects an invalid backend response instead of certifying it', async () => {
  const api = makeApi({ invalidResponse: { code: 500, msg: 'unsupported allocation mode', data: null } })
  const record = makeRecord()
  const caseRecord = makeCaseRecord()
  const fixture = await createCostAllocationClosureFixture({
    api,
    record,
    caseRecord,
    dependencies: {
      config: { target: 'local', tenantId: '1' },
      assertLocalWriteSafety: async () => {},
      effectiveMonth: '2099-02'
    }
  })
  await assert.rejects(
    () => verifyInvalidAllocationMode({ api, fixture, caseRecord }),
    /非法分摊模式精确拒绝/
  )
  const formal = await api.getBusiness(
    `/cost/allocation-rules?modelVersionId=${fixture.modelVersionId}&effectiveMonth=${fixture.effectiveMonth}`
  )
  assert.equal(formal.data.length, 1)
  await cleanupCostAllocationClosureFixture({ api, fixture, caseRecord, recordCheck: false })
})

test('COST-001 scope gate stops before any formal write', async () => {
  const api = makeApi()
  const record = makeRecord()
  const caseRecord = makeCaseRecord()
  let safetyCalls = 0
  await assert.rejects(
    () => createCostAllocationClosureFixture({
      api,
      record: { ...record, environment: { tenantId: '2' } },
      caseRecord,
      dependencies: {
        config: { target: 'local', tenantId: '1' },
        assertLocalWriteSafety: async () => { safetyCalls++ }
      }
    }),
    /租户不是 1/
  )
  assert.equal(safetyCalls, 0)
  assert.equal(api.state.departments.size, 0)
  assert.equal(api.state.models.size, 0)
})

test('COST-001 cleanup failures are surfaced and cannot be swallowed', async () => {
  const api = makeApi({ failDepartmentDelete: true })
  const record = makeRecord()
  const caseRecord = makeCaseRecord()
  const fixture = await createCostAllocationClosureFixture({
    api,
    record,
    caseRecord,
    dependencies: {
      config: { target: 'local', tenantId: '1' },
      assertLocalWriteSafety: async () => {},
      effectiveMonth: '2099-03'
    }
  })
  await assert.rejects(
    () => cleanupCostAllocationClosureFixture({ api, fixture, caseRecord }),
    /专属夹具清理失败|专属部门清理失败/
  )
  assert.equal(caseRecord.checks.at(-1).name, COST_ALLOCATION_CLOSURE_CHECKS.cleanup)
  assert.equal(caseRecord.checks.at(-1).passed, false)
})

test('browser boundary checks are named and do not require an allocation-rule PUT', async () => {
  const api = makeApi()
  const record = makeRecord()
  const caseRecord = makeCaseRecord()
  await runCostAllocationClosure({
    api,
    page: {},
    record,
    caseRecord,
    dependencies: {
      config: { target: 'local', tenantId: '1' },
      assertLocalWriteSafety: async () => {},
      browserActions: fakeBrowser,
      effectiveMonth: '2099-04'
    }
  })
  assert.equal(
    caseRecord.checks.filter((check) =>
      check.name === COST_ALLOCATION_CLOSURE_CHECKS.browserCancel ||
      check.name === COST_ALLOCATION_CLOSURE_CHECKS.browserRefresh
    ).length,
    2
  )
  assert.equal(record.api.filter((entry) =>
    entry.method === 'PUT' && entry.pathname === '/cost/allocation-rules'
  ).length, 0)
})

test('browser closure uses explicit model selection after refresh and formal values after every discard', async () => {
  const api = makeApi()
  const record = makeRecord()
  const caseRecord = makeCaseRecord()
  const calls = []
  await runCostAllocationClosure({
    api, page: {}, record, caseRecord,
    dependencies: {
      config: { target: 'local', tenantId: '1' },
      assertLocalWriteSafety: async () => {},
      browserActions: Object.fromEntries(Object.entries(fakeBrowser).map(([name, fn]) => [
        name, async (...args) => {
          calls.push(name)
          if (name === 'assertDedicatedRows' || name === 'assertFormalValues') {
            assert.ok(args[1].modelVersionId)
            assert.ok(args[1].componentItemCode)
          }
          return fn(...args)
        }
      ]))
    }
  })
  assert.deepEqual(calls, [
    'open', 'assertDedicatedRows', 'assertFormalValues',
    'editDraft', 'cancelDraft', 'assertFormalValues',
    'editDraft', 'refresh', 'assertDedicatedRows', 'assertFormalValues', 'verifyModeControls'
  ])
})

test('route-away cancellation no longer certifies the browser boundary', async () => {
  const api = makeApi()
  const record = makeRecord()
  const caseRecord = makeCaseRecord()
  const fixture = await createCostAllocationClosureFixture({
    api, record, caseRecord,
    dependencies: {
      config: { target: 'local', tenantId: '1' },
      assertLocalWriteSafety: async () => {}
    }
  })
  await assert.rejects(() => verifyBrowserDraftBoundaries({
    api, page: {}, fixture, record, caseRecord,
    dependencies: {
      browserActions: { ...fakeBrowser, async cancelDraft () { return 'route-away' } }
    }
  }), /mode=route-away/)
})

test('default browser selects the owned model via labeled UI and checks exact formal request IDs', async () => {
  const api = makeApi()
  const record = makeRecord()
  const caseRecord = makeCaseRecord()
  const fixture = await createCostAllocationClosureFixture({
    api, record, caseRecord,
    dependencies: {
      config: { target: 'local', tenantId: '1' },
      assertLocalWriteSafety: async () => {}
    }
  })
  const calls = []
  const locator = {
    async waitFor () {},
    async click () { calls.push('click') },
    async count () { return 1 },
    first () { return this },
    filter ({ hasText }) { calls.push(hasText); return this }
  }
  const modelLocator = {
    ...locator,
    async waitFor () {},
    getByRole (role, options) {
      assert.equal(role, 'combobox')
      assert.deepEqual(options, { name: '成本模型版本', exact: true })
      return {
        async fill (value) {
          assert.equal(value, __internal.modelPayload(fixture).versionNo)
          calls.push('model-search')
        }
      }
    }
  }
  const page = {
    locator (selector) {
      if (selector === '.model-context-meta .el-select:has(input[aria-label="成本模型版本"])') {
        calls.push('labeled-select')
        return modelLocator
      }
      return locator
    },
    getByRole (role, options) {
      assert.equal(role, 'option')
      assert.equal(options.name,
        `${__internal.modelPayload(fixture).versionNo} · ${fixture.effectiveMonth} · 生产`)
      return locator
    },
    async waitForResponse (predicate) {
      const paths = [
        `/cost/model-versions/${fixture.modelVersionId}/components`,
        `/cost/allocation-rules?modelVersionId=${fixture.modelVersionId}&effectiveMonth=${fixture.effectiveMonth}`,
        `/cost/centers?accountingOrgId=${fixture.accountingOrgId}`
      ]
      const response = (path) => ({
        url: () => `http://localhost/admin-api${path}`,
        request: () => ({ method: () => 'GET' }),
        json: () => api.getBusiness(path)
      })
      const match = paths.map(response).find(predicate)
      assert.ok(match)
      calls.push(match.url())
      assert.equal(predicate(response(paths[1].replace(fixture.modelVersionId, '123'))), false)
      assert.equal(predicate(response('/cost/centers?accountingOrgId=2')), false)
      return match
    },
  }
  await __internal.defaultBrowserActions.assertDedicatedRows(page, fixture)
  assert.equal(calls[0], 'labeled-select')
  assert.ok(calls.includes('model-search'))
  assert.ok(calls.some((value) => value.endsWith('/cost/centers?accountingOrgId=1')))
  assert.ok(calls.includes(fixture.costCenterCode))
  assert.ok(calls.includes(fixture.componentItemCode))
})

test('default cancel requires the workspace button and does not navigate elsewhere', async () => {
  let clicks = 0
  const page = {
    url: () => 'http://localhost/cost-management/modeling/allocation-rule',
    locator (selector) {
      assert.equal(selector, '.workspace-actions')
      return {
        getByRole (role, options) {
          assert.equal(role, 'button')
          assert.deepEqual(options, { name: '取消', exact: true })
          return {
            async waitFor () {},
            async count () { return 1 },
            async click () { clicks++ }
          }
        }
      }
    }
  }
  assert.equal(await __internal.defaultBrowserActions.cancelDraft(page), 'button')
  assert.equal(clicks, 1)
})

const sharedRows = () => ['4', '13'].map((id) => ({
  id, tenantId: '1', orgId: '1', key: `owned-shared-${id}`,
  version: '144', updatedAt: '2026-10-12 12:25:59', hash: 'a'.repeat(64), length: '15'
}))

test('shared workspace snapshot refuses missing, repeated, or invalid database evidence', async () => {
  const sqlRows = sharedRows().map((row) => [
    row.id, row.tenantId, row.orgId, row.key, row.version, row.updatedAt, row.hash, row.length
  ])
  const result = await readSharedCostWorkspaceSnapshot(async (sql) => {
    assert.match(sql, /tenant_id = 1 AND accounting_org_id = 1 AND id IN \(13, 4\)/)
    assert.doesNotMatch(sql, /\bUPDATE\b|\bINSERT\b|\bDELETE\b/i)
    return { available: true, rows: sqlRows }
  })
  assert.deepEqual(result, sharedRows())
  for (const rows of [[], [sqlRows[0], sqlRows[0]], [sqlRows[0], [...sqlRows[1].slice(0, 6), 'bad', '15']]]) {
    await assert.rejects(() => readSharedCostWorkspaceSnapshot(async () => ({
      available: true, rows
    })), /shared workspace/)
  }
})

test('shared workspace verifies before/after and records even an aborted PUT attempt as failure', async () => {
  const page = new EventEmitter()
  const caseRecord = makeCaseRecord()
  await assert.rejects(() => verifyCostSharedWorkspaceBoundary({
    page, caseRecord,
    dependencies: { readSnapshot: async () => sharedRows() },
    operation: async () => {
      page.emit('request', {
        method: () => 'PUT',
        url: () => 'http://localhost/admin-api/cost/workspace-states/save'
      })
    }
  }), /无 PUT/)
  assert.equal(caseRecord.sharedWorkspaceBoundary.unchanged, true)
  assert.equal(caseRecord.sharedWorkspaceBoundary.attemptedPuts.length, 1)
  assert.equal(caseRecord.checks.at(-1).passed, false)
  assert.equal(page.listenerCount('request'), 0)
})

test('shared workspace version-only changes fail without any restoring writes', async () => {
  const page = new EventEmitter()
  const caseRecord = makeCaseRecord()
  let snapshots = 0
  await assert.rejects(() => verifyCostSharedWorkspaceBoundary({
    page, caseRecord,
    dependencies: {
      readSnapshot: async () => sharedRows().map((row) => ({
        ...row, version: String(144 + snapshots++)
      }))
    },
    operation: async () => {}
  }), /无 PUT/)
  assert.equal(caseRecord.sharedWorkspaceBoundary.attemptedPuts.length, 0)
  assert.equal(caseRecord.sharedWorkspaceBoundary.unchanged, false)
})

test('shared evidence survives operation failure, preserves the error, and removes listeners', async () => {
  const page = new EventEmitter()
  const caseRecord = makeCaseRecord()
  await assert.rejects(() => verifyCostSharedWorkspaceBoundary({
    page, caseRecord,
    dependencies: { readSnapshot: async () => sharedRows() },
    operation: async () => { throw new Error('real browser failure') }
  }), /real browser failure/)
  assert.equal(caseRecord.sharedWorkspaceBoundary.unchanged, true)
  assert.equal(caseRecord.checks.at(-1).passed, true)
  assert.equal(page.listenerCount('request'), 0)
})
