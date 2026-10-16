import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  EVALUATION_ACCEPTANCE_GAPS,
  assertEvaluationLocalTarget,
  assertExactEvaluationRejection,
  cleanupEvaluationFixtures,
  createOwnedEvaluationTemplate,
  evaluateOwnedTicket,
  evaluationId,
  evaluationTemplateSnapshot,
  newEvaluationFixture,
  prepareEvaluationFixtures,
  readEvaluationConfig,
  readEvaluationStatistics,
  readOwnedEvaluation,
  verifyEvaluationItemProtection,
  verifyEvaluationVersionFreeze
} from '../fixtures/project-after-sales-evaluation-closure.mjs'
import {
  appendEvaluationGapEvidence,
  runEvaluationClosureCase
} from '../fixtures/project-after-sales-evaluation-cases.mjs'
import {
  PROJECT_AFTER_SALES_ACCEPTANCE_GAPS,
  PROJECT_AFTER_SALES_CATALOG_ASSERTIONS,
  finalizeProjectAfterSalesCatalogAssertions,
  initializeProjectAfterSalesCatalogAssertions
} from '../suites/project-after-sales.mjs'

const ok = (data) => ({ code: 0, data, msg: '' })
const kinds = {
  category: 'CATEGORY', 'sla-policy': 'SLA_POLICY',
  'evaluation-item-category': 'EVALUATION_ITEM_CATEGORY',
  'evaluation-item': 'EVALUATION_ITEM', 'evaluation-template': 'EVALUATION_TEMPLATE'
}
const mockApi = (fixture) => {
  let sequence = 2109000000000000000n
  const next = () => String(++sequence)
  const tables = Object.fromEntries(Object.values(kinds).map((kind) => [kind, []]))
  const state = { tables, calls: [], material: null, asset: null, customer: null, ticket: null,
    evaluation: null, revisions: [], failure: null }
  const getRow = (kind, id) => tables[kind].find((row) => row.id === id)
  const execute = async (method, pathname, body) => {
    state.calls.push({ method, pathname, body: structuredClone(body) })
    if (state.failure) await state.failure(method, pathname, body)
    const url = new URL(pathname, 'http://localhost')
    const id = url.searchParams.get('id')
    const ticketId = url.searchParams.get('ticketId')
    const segments = url.pathname.split('/')
    const action = segments.at(-1)
    const kind = kinds[segments.at(-2)]
    if (method === 'GET') {
      if (pathname === '/mes/basUnit/list/enabled') return ok([{ id: '10' }])
      if (pathname.startsWith('/mes/basMaterial/queryById')) return ok(structuredClone(state.material))
      if (kind && action === 'list') return ok(structuredClone(tables[kind]))
      if (url.pathname.endsWith('/modeling/revisions')) return ok(structuredClone(state.revisions))
      if (url.pathname.endsWith('/asset/get')) return ok({
        customer: structuredClone(state.customer), asset: structuredClone(state.asset),
        servicePeriods: [{ ...fixture.period, sourceNo: fixture.assetNo, status: 'VALID' }]
      })
      if (url.pathname.endsWith('/ticket/get')) return ok(structuredClone(state.ticket))
      if (url.pathname.endsWith('/sla/get')) return ok({
        ticketId, policyId: fixture.sla.id,
        policySnapshotJson: JSON.stringify({ policyCode: fixture.sla.body.policyCode })
      })
      if (url.pathname.endsWith('/evaluation/get')) return ok(structuredClone(state.evaluation))
      if (url.pathname.endsWith('/report/analysis')) return ok({
        scope: { start: url.searchParams.get('start'), end: url.searchParams.get('end'),
          customerId: url.searchParams.get('customerId'), assetId: null },
        total: 1, resolved: 1, evaluationCount: 1, customerScore: 5,
        issueDetails: [{ id: fixture.ticketId, assetId: fixture.assetId,
          description: fixture.ticketTitle, status: 'CLOSED' }],
        formula: { resolutionRate: 'resolved/total' }, status: { CLOSED: 1 }
      })
    }
    if (method === 'POST') {
      if (pathname === '/mes/basMaterial/add') {
        assert.equal(body.leadTime, 1)
        assert.equal(body.bufferTime, 1)
        state.material = { ...body, id: next() }
        return ok(state.material.id)
      }
      if (url.pathname.endsWith('/customer-profile/create')) {
        const customerId = next()
        const contactId = next()
        const assetId = next()
        state.customer = { id: customerId, customerNo: body.customerNo }
        state.asset = { ...body.assets[0], id: assetId, customerId, serviceStatus: 'IN_SERVICE',
          serviceStartDate: fixture.period.startDate, serviceEndDate: fixture.period.endDate, version: 0 }
        return ok({ customerId, primaryContactId: contactId, assetIds: [assetId] })
      }
      if (kind && action === 'create') {
        const row = { ...body, id: next(), status: 'ENABLED', tenantId: '1' }
        if (kind === 'CATEGORY') row.leafFlag = true
        if (kind === 'EVALUATION_ITEM') {
          row.optionsJson = JSON.stringify(body.options)
          row.requiredFlag = body.required
          row.systemRequiredFlag = body.evaluationType === 'RESOLUTION_CONFIRM'
          row.version = 0
        }
        if (kind === 'EVALUATION_TEMPLATE') {
          row.status = 'DRAFT'
          row.totalScore = 100
          row.items = body.items.map((entry) => {
            const item = getRow('EVALUATION_ITEM', entry.itemId)
            return {
              id: next(), templateId: row.id, itemId: entry.itemId,
              itemNameSnapshot: item.itemName, evaluationTypeSnapshot: item.evaluationType,
              optionsSnapshotJson: item.optionsJson, score: entry.score,
              requiredFlag: item.systemRequiredFlag || entry.required, sortNo: entry.sortNo,
              tenantId: '1', createTime: '2026-10-12 00:00:00'
            }
          }).sort((left, right) => left.sortNo - right.sortNo)
        }
        tables[kind].push(row)
        return ok(row.id)
      }
      if (kind === 'EVALUATION_TEMPLATE' && action === 'enable') {
        getRow(kind, id).status = 'ENABLED'
        return ok(true)
      }
      if (url.pathname.endsWith('/modeling/status')) {
        getRow(url.searchParams.get('configType'), id).status = 'DISABLED'
        return ok(true)
      }
      if (url.pathname.endsWith('/ticket/create')) {
        state.ticket = { ...body, id: next(), status: 'PENDING_ACCEPTANCE' }
        return ok(state.ticket.id)
      }
      if (url.pathname.endsWith('/ticket/process')) {
        state.ticket.status = body.targetStatus
        state.ticket.resolution = body.resolution
        return ok(true)
      }
      if (url.pathname.endsWith('/ticket/customer-confirm')) {
        state.ticket.status = 'PENDING_EVALUATION'
        return ok(true)
      }
      if (url.pathname.endsWith('/ticket/evaluate')) {
        const template = getRow('EVALUATION_TEMPLATE', body.templateId)
        state.evaluation = {
          id: next(), ticketId: body.ticketId, templateId: body.templateId,
          templateVersionNo: template.versionNo,
          templateSnapshotJson: JSON.stringify({
            templateId: template.id, templateCode: template.templateCode,
            templateName: template.templateName, versionNo: template.versionNo,
            totalScore: template.totalScore, items: template.items
          }),
          score: body.score, evaluationContent: body.content, evaluatorName: body.evaluatorName,
          evaluationTime: '2026-10-12 01:00:00'
        }
        state.ticket.status = 'CLOSED'
        state.ticket.evaluationStatus = 'COMPLETED'
        return ok(true)
      }
      if (url.pathname.endsWith('/ticket/close')) {
        state.ticket.status = 'CLOSED'
        return ok(true)
      }
    }
    if (method === 'PUT') {
      if (kind === 'EVALUATION_ITEM' && action === 'update') {
        const row = getRow(kind, id)
        if (row.itemCode !== body.itemCode) return {
          code: 1020055, msg: '评价项目编码是稳定引用，创建后不能修改'
        }
        Object.assign(row, body, { optionsJson: JSON.stringify(body.options), requiredFlag: body.required })
        row.version++
        return ok(true)
      }
      if (url.pathname.endsWith('/asset/update-status')) {
        assert.equal(body.version, state.asset.version)
        state.asset.serviceStatus = body.serviceStatus
        state.asset.version++
        return ok(true)
      }
    }
    if (method === 'DELETE' && kind === 'EVALUATION_ITEM') {
      return { code: 1020056, msg: '评价项目已被评价模板引用，只能停用不能删除' }
    }
    throw new Error(`Unexpected ${method} ${pathname}`)
  }
  return {
    state, execute, getBusiness: (path) => execute('GET', path),
    postBusiness: (path, body) => execute('POST', path, body),
    putBusiness: (path, body) => execute('PUT', path, body),
    put: (path, body) => execute('PUT', path, body),
    delete: (path) => execute('DELETE', path)
  }
}
const prepared = async (caseId = 'PB129-001') => {
  const fixture = newEvaluationFixture(caseId, new Date('2026-10-11T17:30:00Z'))
  const api = mockApi(fixture)
  await prepareEvaluationFixtures(api, fixture)
  const template = await createOwnedEvaluationTemplate(api, fixture)
  return { fixture, api, template }
}

test('PB128/129 gap mapping exactly matches catalog without sharing evidence names', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const cases = catalog.suites.flatMap((suite) => suite.cases)
  const names = []
  for (const [caseId, gaps] of Object.entries(EVALUATION_ACCEPTANCE_GAPS)) {
    const entry = cases.find((row) => row.id === caseId)
    assert.ok(entry)
    assert.deepEqual(gaps.map((gap) => gap.assertion), entry.acceptanceGaps)
    assert.ok(gaps.every((gap) => gap.check.startsWith(`${caseId.slice(0, 5)}/`)))
    names.push(...gaps.map((gap) => gap.check))
  }
  assert.equal(new Set(names).size, 6)
})

test('evaluation fixtures enforce local database/tenant/ports and lossless IDs', () => {
  const target = { target: 'local', tenantId: '1', db: { name: 'cfor_admin_standard' },
    apiBase: 'http://127.0.0.1:48083', webBase: 'http://127.0.0.1:9151' }
  assert.doesNotThrow(() => assertEvaluationLocalTarget(target))
  for (const override of [{ tenantId: 2 }, { target: 'prod' }, { db: { name: 'cfor_admin_saas' } },
    { apiBase: 'http://example.org:48083' }, { webBase: 'http://127.0.0.1:9152' }]) {
    assert.throws(() => assertEvaluationLocalTarget({ ...target, ...override }))
  }
  for (const value of [null, undefined, '', false, {}, 0, -1, 1.5, '01', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => evaluationId(value))
  }
  assert.equal(evaluationId('2109000000000000001'), '2109000000000000001')
})

test('PB128 and PB129 independently prepare every owned business reference with purchase timing', async () => {
  const first = await prepared('PB128-001')
  const second = await prepared('PB129-001')
  assert.notEqual(first.fixture.marker, second.fixture.marker)
  for (const { fixture, api } of [first, second]) {
    assert.equal(fixture.reportStart, '2026-10-11')
    assert.equal(fixture.reportEnd, '2026-10-13')
    assert.ok(fixture.materialCode.length <= 30)
    assert.equal(fixture.items.length, 4)
    assert.equal(api.state.material.unitId, '10')
    assert.equal(api.state.asset.materialId, fixture.materialId)
    assert.equal(api.state.customer.customerNo, fixture.customerNo)
    assert.ok(api.state.calls.filter((call) => call.method !== 'GET').every((call) =>
      !JSON.stringify(call.body || '').includes('shared-customer')))
  }
})

test('capped modeling lists fail before writes when they cannot guarantee readback', async () => {
  const fixture = newEvaluationFixture('PB128-001')
  let writes = 0
  await assert.rejects(prepareEvaluationFixtures({
    getBusiness: async () => ok(Array.from({ length: 98 }, (_, index) => ({ id: String(index + 1) }))),
    postBusiness: async () => { writes++ }
  }, fixture), /BLOCKED.*capacity/)
  assert.equal(writes, 0)
})

test('complete snapshot comparison rejects mutations to every business field and snapshot identity', async () => {
  const { fixture, api, template } = await prepared()
  const baseline = await readEvaluationConfig(api, fixture, template)
  for (const mutate of [
    (row) => { row.items[1].itemNameSnapshot = 'drift' },
    (row) => { row.items[2].evaluationTypeSnapshot = 'MULTIPLE' },
    (row) => { row.items[2].optionsSnapshotJson = '["UNSATISFIED","SATISFIED"]' },
    (row) => { row.items[1].score = 59; row.items[2].score = 41 },
    (row) => { row.items[1].requiredFlag = false },
    (row) => { row.items[1].sortNo = 3; row.items[2].sortNo = 2 },
    (row) => { row.items[1].itemId = row.items[2].itemId },
    (row) => { row.items[1].templateId = '999' },
    (row) => { row.items[1].tenantId = '2' },
    (row) => { row.items.pop() },
    (row) => { row.items[2].optionsSnapshotJson = 'bad JSON' },
    (row) => { delete row.items[1].requiredFlag },
    (row) => { delete row.items[1].score }
  ]) {
    const changed = structuredClone(baseline)
    mutate(changed)
    assert.throws(() => assert.deepEqual(
      evaluationTemplateSnapshot(changed, fixture, template), template.snapshot))
  }
})

test('PB128 protects stable codes and referenced deletion with exact business codes/messages and zero changes', async () => {
  const { fixture, api, template } = await prepared('PB128-001')
  assert.equal(await verifyEvaluationItemProtection(api, fixture, fixture.items[2], template, true), true)
  assert.ok(api.state.calls.some((call) => call.method === 'PUT' && call.body.itemCode.endsWith('-CHANGED')))
  for (const response of [
    { code: 500, msg: '评价项目已被评价模板引用，只能停用不能删除' },
    { code: 1020056, msg: '评价模板引用' }, { code: 0, msg: '' }, null
  ]) assert.throws(() => assertExactEvaluationRejection(response, 1020056,
    '评价项目已被评价模板引用，只能停用不能删除'))
})

test('negative mutation proofs fail on unchanged-looking response with actual write or appended revision', async () => {
  for (const mutate of [
    (state, fixture) => { state.tables.EVALUATION_ITEM.find((row) => row.id === fixture.items[2].id).version++ },
    (state) => { state.revisions.push({ id: '11', operation: 'UPDATE' }) }
  ]) {
    const { fixture, api, template } = await prepared('PB128-001')
    api.state.failure = async (method) => { if (method === 'PUT') mutate(api.state, fixture) }
    await assert.rejects(verifyEvaluationItemProtection(api, fixture, fixture.items[2], template, true))
  }
})

test('reference protection cannot borrow disabled templates or silently use a truncated revision history', async () => {
  for (const mutate of [
    (api) => { api.state.tables.EVALUATION_TEMPLATE[0].status = 'DISABLED' },
    (api) => { api.state.revisions = Array.from({ length: 100 }, (_, index) => ({ id: String(index + 1) })) }
  ]) {
    const { fixture, api, template } = await prepared()
    mutate(api)
    const start = api.state.calls.length
    await assert.rejects(verifyEvaluationItemProtection(api, fixture, fixture.items[2], template))
    assert.ok(api.state.calls.slice(start).every((call) => call.method === 'GET'))
  }
})

test('PB129 records a real owned-ticket evaluation before V2 and freezes full V1/history/statistics', async () => {
  const { fixture, api, template } = await prepared()
  const evaluation = await evaluateOwnedTicket(api, fixture, template)
  assert.equal(evaluation.templateId, template.id)
  assert.equal(api.state.ticket.status, 'CLOSED')
  const result = await verifyEvaluationVersionFreeze(api, fixture, template)
  assert.equal(result.v1.versionNo, 'V1')
  assert.equal(result.v2.versionNo, 'V2')
  assert.notEqual(result.v1.templateCode, result.v2.templateCode)
  assert.equal(result.v1.templateName, result.v2.templateName)
  assert.deepEqual(result.v1.items.map((item) => item.score), [0, 60, 40, 0])
  assert.deepEqual(result.v2.items.map((item) => item.score), [0, 70, 30, 0])
  assert.equal(result.v2.items[1].evaluationTypeSnapshot, 'MULTIPLE')
  assert.equal(result.evaluation.templateVersionNo, 'V1')
})

test('formal evaluation rejects absent snapshots, partial content, wrong version and foreign ticket references', async () => {
  const { fixture, api, template } = await prepared()
  await evaluateOwnedTicket(api, fixture, template)
  const initial = structuredClone(api.state.evaluation)
  for (const changes of [
    { templateVersionNo: 'V2' }, { ticketId: '999' }, { templateId: '999' },
    { templateSnapshotJson: JSON.stringify({ templateCode: template.body.templateCode }) },
    { templateSnapshotJson: '{"items":[]}' }, { templateSnapshotJson: 'bad JSON' },
    { evaluationContent: 'shared' }, { score: null }
  ]) {
    api.state.evaluation = { ...initial, ...changes }
    await assert.rejects(readOwnedEvaluation(api, fixture, template))
  }
})

test('customer-scoped statistics cannot pass using global aggregates, foreign issue or empty result', async () => {
  const { fixture, api, template } = await prepared()
  await evaluateOwnedTicket(api, fixture, template)
  const baseline = await readEvaluationStatistics(api, fixture)
  for (const mutate of [
    (row) => { row.scope.customerId = null },
    (row) => { row.total = 2 },
    (row) => { row.evaluationCount = 0 },
    (row) => { row.customerScore = 4 },
    (row) => { row.issueDetails = [] },
    (row) => { row.issueDetails[0].id = '999' }
  ]) {
    const changed = structuredClone(baseline)
    mutate(changed)
    await assert.rejects(readEvaluationStatistics({ getBusiness: async () => ok(changed) }, fixture))
  }
})

test('cleanup closes unfinished ticket before asset retirement and disables all owned configurations with readback', async () => {
  const { fixture, api, template } = await prepared()
  await evaluateOwnedTicket(api, fixture, template)
  api.state.ticket.status = 'PROCESSING'
  const start = api.state.calls.length
  const result = await cleanupEvaluationFixtures(api, fixture)
  assert.equal(result.ticketClosed, true)
  assert.equal(api.state.asset.serviceStatus, 'RETIRED')
  assert.ok(Object.values(api.state.tables).flat().every((row) => row.status === 'DISABLED'))
  const calls = api.state.calls.slice(start)
  const close = calls.findIndex((call) => call.pathname.includes('/ticket/close'))
  const retire = calls.findIndex((call) => call.pathname === '/after-sales/asset/update-status')
  const disable = calls.findIndex((call) => call.pathname.includes('/modeling/status'))
  assert.ok(close >= 0 && retire > close && disable > retire)
  assert.equal(result.retainedAudit.customerId, fixture.customerId)
  assert.ok(!calls.some((call) => call.method === 'DELETE'))
})

test('cleanup aggregates first retirement failure and later disabled readback error while continuing independent cleanup', async () => {
  const { fixture, api, template } = await prepared()
  await evaluateOwnedTicket(api, fixture, template)
  api.state.failure = async (method, path) => {
    if (method === 'PUT' && path === '/after-sales/asset/update-status') throw new Error('HTTP 401')
    if (method === 'POST' && path.includes(`configType=EVALUATION_TEMPLATE&id=${template.id}`)) {
      throw new Error('HTTP 500 disable')
    }
  }
  await assert.rejects(cleanupEvaluationFixtures(api, fixture), (error) => {
    assert.ok(error instanceof AggregateError)
    assert.match(error.message, /HTTP 401/)
    assert.match(error.message, /HTTP 500 disable/)
    return true
  })
  assert.equal(api.state.tables.CATEGORY[0].status, 'DISABLED')
  assert.equal(api.state.tables.SLA_POLICY[0].status, 'DISABLED')
  assert.equal(api.state.tables.EVALUATION_ITEM_CATEGORY[0].status, 'DISABLED')
})

test('cleanup protects shared ownership and dependencies after ticket close failure, but still verifies material audit', async () => {
  const { fixture, api, template } = await prepared()
  await evaluateOwnedTicket(api, fixture, template)
  api.state.ticket.customerId = '999'
  const start = api.state.calls.length
  await assert.rejects(cleanupEvaluationFixtures(api, fixture), /cleanup incomplete/)
  const calls = api.state.calls.slice(start)
  assert.ok(!calls.some((call) => call.method !== 'GET'))
  assert.ok(calls.some((call) => call.pathname.startsWith('/mes/basMaterial/queryById')))
  assert.equal(api.state.asset.serviceStatus, 'IN_SERVICE')
  assert.equal(api.state.tables.SLA_POLICY[0].status, 'ENABLED')
})

test('pending configuration create is recovered only by unique owned code and capped absence is never assumed', async () => {
  const { fixture, api } = await prepared()
  const resource = fixture.resources.find((row) => row.type === 'EVALUATION_ITEM')
  resource.id = undefined
  resource.pending = true
  await cleanupEvaluationFixtures(api, fixture)
  assert.ok(resource.id)
  assert.equal(api.state.tables.EVALUATION_ITEM[0].status, 'DISABLED')
  const duplicate = await prepared()
  duplicate.api.state.tables.EVALUATION_ITEM.push(structuredClone(duplicate.api.state.tables.EVALUATION_ITEM[0]))
  await assert.rejects(cleanupEvaluationFixtures(duplicate.api, duplicate.fixture), /duplicate IDs/)
})

test('pending configuration absence at the list cap fails closed and independent cleanup continues', async () => {
  const { fixture, api } = await prepared()
  const resource = fixture.resources.find((row) => row.type === 'EVALUATION_ITEM')
  resource.id = undefined
  resource.pending = true
  api.state.tables.EVALUATION_ITEM = Array.from({ length: 100 }, (_, index) => ({
    id: String(index + 1), itemCode: `FOREIGN-${index}`, categoryId: fixture.evaluationCategory.id
  }))
  await assert.rejects(cleanupEvaluationFixtures(api, fixture), /uncertain configuration create/)
  assert.equal(api.state.tables.CATEGORY[0].status, 'DISABLED')
  assert.ok(api.state.tables.EVALUATION_ITEM.every((row) => row.status === undefined))
})

test('cleanup does not conceal disabled readback failures or raw read errors', async () => {
  const { fixture, api } = await prepared()
  api.state.failure = async (method, path) => {
    if (method === 'GET' && path.endsWith('/evaluation-template/list') &&
        api.state.tables.EVALUATION_TEMPLATE[0].status === 'DISABLED') throw new Error('HTTP 401 readback')
  }
  await assert.rejects(cleanupEvaluationFixtures(api, fixture), /HTTP 401 readback/)
  assert.equal(api.state.tables.CATEGORY[0].status, 'DISABLED')
})

test('unused material cleanup requires zero asset/inventory references and exact post-delete API/raw absence', async () => {
  const fixture = newEvaluationFixture('PB128-001')
  fixture.materialAttempted = true
  fixture.materialId = '2109000000000000001'
  const material = { id: fixture.materialId, code: fixture.materialCode, remark: fixture.marker }
  const calls = []
  const api = {
    getBusiness: async (path) => {
      calls.push(path)
      return path.includes('/list?') ? ok({ total: 0, records: [] }) : ok(material)
    },
    deleteBusiness: async (path) => { calls.push(path); return ok(true) }
  }
  const queries = []
  const readSql = async (statement) => {
    queries.push(statement)
    return { available: true, rows: [['0']] }
  }
  const result = await cleanupEvaluationFixtures(api, fixture, readSql)
  assert.equal(result.retainedAudit.materialId, undefined)
  assert.equal(fixture.materialDeleted, true)
  assert.equal(queries.length, 3)
  assert.match(queries[0], /after_sales_customer_asset/)
  assert.match(queries[1], /mes_stk_inventory/)
  assert.match(queries[2], /mes_bas_material/)
  assert.ok(queries.every((sql) => !/\b(?:UPDATE|DELETE|INSERT)\b/i.test(sql)))
  assert.equal(calls.filter((path) => path.includes('/delete?')).length, 1)
  for (const evidence of [
    { available: false, reason: 'read offline' }, { available: true, rows: [['1']] },
    { available: true, rows: [] }
  ]) {
    let deletes = 0
    await assert.rejects(cleanupEvaluationFixtures({
      getBusiness: async () => ok(material),
      deleteBusiness: async () => { deletes++; return ok(true) }
    }, { ...fixture, materialDeleted: false }, async () => evidence))
    assert.equal(deletes, 0)
  }
})

test('uncertain profile creation preserves material audit and reports the unresolved asset instead of deleting references', async () => {
  const fixture = newEvaluationFixture('PB129-001')
  fixture.materialId = '2109000000000000001'
  fixture.materialAttempted = true
  fixture.profileAttempted = true
  let deletes = 0
  await assert.rejects(cleanupEvaluationFixtures({
    getBusiness: async () => ok({ id: fixture.materialId, code: fixture.materialCode, remark: fixture.marker }),
    deleteBusiness: async () => { deletes++ }
  }, fixture), /profile create result uncertain/)
  assert.equal(deletes, 0)
})

const mockedPageOperations = {
  saveItem: async (page, api, fixture, item, expected) => {
    await api.putBusiness(`/after-sales/modeling/evaluation-item/update?id=${item.id}`, expected)
    const saved = await readEvaluationConfig(api, fixture, item)
    return {
      form: {
        categoryLabel: fixture.alternateCategory.body.categoryName,
        itemCode: expected.itemCode, itemName: expected.itemName, methodLabel: '多选',
        optionsText: expected.options.join(' / '), maxScore: String(expected.maxScore),
        required: expected.required, enabled: true
      },
      saved, persisted: structuredClone(saved)
    }
  },
  verifyTemplatePage: async (page, fixture, template) => {
    const labels = { RESOLUTION_CONFIRM: '解决确认', STAR: '五星评分', SINGLE: '单选', TEXT: '文本填写' }
    return template.snapshot.items.map((item) => ({
      name: item.itemNameSnapshot, methodLabel: labels[item.evaluationTypeSnapshot],
      score: String(item.score), required: item.requiredFlag, sortNo: String(item.sortNo)
    }))
  }
}

test('independent PB128/PB129 case helper closes only its own exact gaps after successful cleanup', async () => {
  for (const caseId of ['PB128-001', 'PB129-001']) {
    const fixture = newEvaluationFixture(caseId)
    const api = mockApi(fixture)
    const record = { checks: [], notes: [], catalogAssertions: [] }
    const result = await runEvaluationClosureCase({
      caseId, api, fixture, page: {}, caseRecord: record
    }, mockedPageOperations)
    assert.equal(result.partial, false)
    assert.equal(record.evaluationFixture, fixture)
    assert.deepEqual(record.catalogAssertions.map((row) => row.assertion),
      EVALUATION_ACCEPTANCE_GAPS[caseId].map((gap) => gap.assertion))
    assert.ok(record.acceptanceGapAssertions.every((row) => row.status === 'VERIFIED' &&
      row.evidenceChecks.length === 1))
    assert.equal(new Set(record.checks.map((check) => check.name)).size, record.checks.length)
    assert.ok(record.checks.every((check) => check.passed === true))
    assert.equal(api.state.ticket.status, 'CLOSED')
    assert.equal(api.state.asset.serviceStatus, 'RETIRED')
    assert.ok(Object.values(api.state.tables).flat().every((row) => row.status === 'DISABLED'))
    assert.deepEqual(record.remainingAssertions, [])
  }
})

test('strict gap ledger cannot verify missing, truthy, duplicate or other-case evidence', () => {
  const evidence = [
    'PB128/stable-code-and-reference-protection', 'PB128/browser-save-reload-all-fields',
    'PB128/formal-evaluation-frozen-version', 'PB128/cleanup'
  ]
  for (const checks of [
    [],
    evidence.map((name) => ({ name, passed: 1 })),
    evidence.map((name) => ({ name: name.replace('PB128', 'PB129'), passed: true })),
    [...evidence, ...evidence].map((name) => ({ name, passed: true }))
  ]) {
    const record = { checks, catalogAssertions: [] }
    const rows = appendEvaluationGapEvidence(record, 'PB128-001')
    assert.equal(rows.length, 3)
    assert.ok(rows.every((row) => row.status === 'GAP' && row.evidenceChecks.length > 0))
    assert.deepEqual(rows.map((row) => row.assertion),
      EVALUATION_ACCEPTANCE_GAPS['PB128-001'].map((gap) => gap.assertion))
  }
  const record = {
    checks: evidence.map((name) => ({ name, passed: true })),
    catalogAssertions: [{ index: 0, assertion: 'original catalog assertion', status: 'GAP' }]
  }
  assert.ok(appendEvaluationGapEvidence(record, 'PB128-001').every((row) => row.status === 'VERIFIED'))
  assert.equal(record.catalogAssertions[0].assertion, 'original catalog assertion')
  assert.equal(record.remainingAssertions[0], 'original catalog assertion')
})

test('case helper surfaces both business/page and cleanup failures while retaining all exact GAP rows', async () => {
  const fixture = newEvaluationFixture('PB128-001')
  const api = mockApi(fixture)
  const record = { checks: [], notes: [] }
  api.state.failure = async (method, path) => {
    if (method === 'PUT' && path.endsWith('/asset/update-status')) throw new Error('cleanup HTTP 401')
  }
  await assert.rejects(runEvaluationClosureCase({
    caseId: fixture.caseId, api, fixture, page: {}, caseRecord: record
  }, {
    ...mockedPageOperations, saveItem: async () => { throw new Error('dialog did not close') }
  }), (error) => {
    assert.ok(error instanceof AggregateError)
    assert.match(error.message, /dialog did not close/)
    assert.match(error.message, /cleanup HTTP 401/)
    return true
  })
  assert.equal(record.acceptanceGapAssertions.length, 3)
  assert.ok(record.acceptanceGapAssertions.every((row) => row.status === 'GAP'))
  assert.equal(api.state.tables.CATEGORY[0].status, 'DISABLED')
  assert.equal(api.state.tables.SLA_POLICY[0].status, 'DISABLED')
})

test('PB128/129 suite mappings retain every original catalog assertion and exact acceptance gap', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const definitions = catalog.suites.flatMap((suite) => suite.cases)
  for (const caseId of ['PB128-001', 'PB129-001']) {
    const definition = definitions.find((row) => row.id === caseId)
    assert.deepEqual(PROJECT_AFTER_SALES_CATALOG_ASSERTIONS[caseId], definition.assertions)
    assert.deepEqual(PROJECT_AFTER_SALES_ACCEPTANCE_GAPS[caseId].map((gap) => gap.assertion),
      definition.acceptanceGaps)
    assert.equal(PROJECT_AFTER_SALES_ACCEPTANCE_GAPS[caseId], EVALUATION_ACCEPTANCE_GAPS[caseId])
  }
})

for (const caseId of ['PB128-001', 'PB129-001']) {
  test(`${caseId} complete isolated evidence passes the real suite finalizer without a generic GAP`, async () => {
    const fixture = newEvaluationFixture(caseId)
    const api = mockApi(fixture)
    const record = { checks: [], notes: [] }
    initializeProjectAfterSalesCatalogAssertions(record, caseId)
    const closure = await runEvaluationClosureCase({
      caseId, api, fixture, page: {}, caseRecord: record
    }, mockedPageOperations)
    const result = finalizeProjectAfterSalesCatalogAssertions(record, caseId, closure)
    assert.equal(result.partial, false)
    assert.equal(result.passCandidate, true)
    assert.equal(result.acceptanceComplete, true)
    assert.equal(record.passCandidate, true)
    assert.deepEqual(record.remainingAssertions, [])
    assert.deepEqual(record.catalogAssertions.map((row) => row.assertion), [
      ...PROJECT_AFTER_SALES_CATALOG_ASSERTIONS[caseId],
      ...EVALUATION_ACCEPTANCE_GAPS[caseId].map((gap) => gap.assertion)
    ])
    assert.deepEqual(record.catalogAssertions.map((row) => row.index), [0, 1, 2, 3, 4])
    for (const row of record.catalogAssertions) {
      assert.equal(row.status, 'VERIFIED')
      assert.ok(row.evidenceChecks.length > 0)
      assert.equal(new Set(row.evidenceChecks).size, row.evidenceChecks.length)
      for (const name of row.evidenceChecks) {
        assert.ok(typeof name === 'string' && name.trim())
        const matches = record.checks.filter((check) => check.name === name)
        assert.equal(matches.length, 1)
        assert.equal(matches[0].passed, true)
      }
    }
    assert.equal(new Set(record.checks.map((check) => check.name)).size, record.checks.length)
  })

  test(`${caseId} missing, duplicate, truthy or foreign evidence keeps exact gaps and cannot become a candidate`, async () => {
    const fixture = newEvaluationFixture(caseId)
    const api = mockApi(fixture)
    const original = { checks: [], notes: [] }
    initializeProjectAfterSalesCatalogAssertions(original, caseId)
    await runEvaluationClosureCase({
      caseId, api, fixture, page: {}, caseRecord: original
    }, mockedPageOperations)
    const prefix = fixture.prefix
    const gapNames = EVALUATION_ACCEPTANCE_GAPS[caseId].map((gap) => gap.check)
    const cleanupName = `${prefix}/cleanup`
    const checks = original.checks.filter((check) => !gapNames.includes(check.name))
    for (const mutate of [
      (rows) => rows.filter((row) => row.name !== cleanupName),
      (rows) => [...rows, rows.find((row) => row.name === cleanupName)],
      (rows) => rows.map((row) => row.name === cleanupName ? { ...row, passed: 1 } : row),
      (rows) => rows.map((row) => row.name === cleanupName ? { ...row, passed: false } : row),
      (rows) => rows.map((row) => row.name === cleanupName
        ? { ...row, name: `${prefix === 'PB128' ? 'PB129' : 'PB128'}/cleanup` } : row)
    ]) {
      const record = { checks: mutate(structuredClone(checks)), notes: [] }
      initializeProjectAfterSalesCatalogAssertions(record, caseId)
      appendEvaluationGapEvidence(record, caseId)
      const result = finalizeProjectAfterSalesCatalogAssertions(record, caseId)
      assert.equal(result.partial, true)
      assert.equal(result.passCandidate, false)
      assert.equal(result.acceptanceComplete, false)
      assert.deepEqual(record.remainingAssertions,
        EVALUATION_ACCEPTANCE_GAPS[caseId].map((gap) => gap.assertion))
      assert.ok(record.acceptanceGapAssertions.every((row) => row.status === 'GAP' &&
        row.evidenceChecks.length === 1))
      assert.equal(record.catalogAssertions.length, 5)
    }
  })
}
