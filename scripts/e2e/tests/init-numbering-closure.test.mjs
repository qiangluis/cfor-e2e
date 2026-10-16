import assert from 'node:assert/strict'
import test from 'node:test'
import {
  initNumberingClosureChecks, initNumberingClosureEvidence, initNumberingClosurePrerequisites,
  runInitNumberingClosure
} from '../fixtures/init-numbering-closure.mjs'

const clone = (value) => structuredClone(value)
const ok = (data) => ({ code: 0, data })
const NOW = Date.parse('2026-10-12T14:00:00+08:00')
const UUID = '01234567-89ab-4cde-8fab-0123456789ab'
const SETTINGS = {
  target: 'local', tenantId: '1', tenantName: 'CFOR 标准平台',
  webBase: 'http://127.0.0.1:9151', apiBase: 'http://127.0.0.1:48083',
  apiUrl: 'http://127.0.0.1:48083/admin-api',
  db: { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard', user: 'unit-test-only' }
}

// Stateful API and SQL doubles model persisted facts independently of API responses.
// No real API client, browser or database process is used by these tests.
function harness (options = {}) {
  const state = {
    requests: [], sql: [], rules: [], warehouses: [], areas: [], locations: [], materials: [],
    bills: [], entries: [], sequences: [], inventory: [], outlook: [],
    allocations: 0, voidAttempts: 0, audits: 0, safetyCalls: 0, clockCalls: 0,
    nextId: 9007199254741000n
  }
  const nextId = () => String(++state.nextId)
  const record = { checks: [], fixtures: [], database: [], notes: [] }
  const req = (method, path, body) => state.requests.push({ method, path, body: clone(body) })
  const writes = () => state.requests.filter((request) => request.method !== 'GET')
  const findRule = (id) => state.rules.find((row) => row.id === id)
  const number = () => {
    state.allocations++
    const published = state.rules.filter((row) => row.status === 'PUBLISHED' && row.effectiveFrom <= NOW)
    let rule = [...published].sort((a, b) => b.effectiveFrom - a.effectiveFrom || b.versionNo - a.versionNo)[0]
    if (options.staleV2 && state.allocations === 3) rule = published[0]
    const params = JSON.parse(rule.ruleParams)
    const prefix = params.segments.find((row) => row.type === 'CONSTANT').value
    const bucket = options.serverWrongDay ? '20261011' : '20261012'
    const key = `${prefix}-${bucket}-RESET-${bucket}-TENANT-1`
    let seq = state.sequences.find((row) => row.k === key)
    if (!seq) {
      seq = { k: key, v: 0, tenantId: '1' }
      state.sequences.push(seq)
    }
    seq.v++
    if (state.allocations === 2 && options.recycle) seq.v--
    if (state.allocations === 2 && options.skipNumber) seq.v++
    return `${prefix}-${bucket}-${String(seq.v).padStart(5, '0')}`
  }
  const api = {
    async getBusiness (path) {
      req('GET', path)
      const url = new URL(path, SETTINGS.apiBase)
      const id = url.searchParams.get('id')
      if (url.pathname === '/system/auth/get-permission-info') {
        return options.permissionDenied ? { code: 403, msg: 'Denied' } : ok({ user: { id: '10' } })
      }
      if (url.pathname === '/mes/basUnit/list/enabled') return ok(options.noUnits ? [] : [{ id: '2' }])
      if (url.pathname === '/mes/wmsWareHouse/allTree') {
        const rows = clone(state.warehouses)
        if (options.unsafeWarehouseId && rows[0]) rows[0].id = Number.MAX_SAFE_INTEGER + 1
        return ok(rows)
      }
      if (url.pathname === '/mes/wmsHouseArea/list') return ok({ records: clone(state.areas) })
      if (url.pathname === '/mes/basMaterial/queryById') {
        const row = clone(state.materials.find((item) => item.id === id))
        if (options.foreignMaterial && row) row.remark = 'somebody else'
        return ok(row)
      }
      if (url.pathname === '/mes/fillRule/list') {
        const rows = clone(state.rules.filter((row) => row.ruleCode === url.searchParams.get('ruleCode')))
        if (options.ambiguousRules && rows.length) rows.push(clone(rows[0]))
        return ok({ records: rows })
      }
      if (url.pathname === '/mes/fillRule/queryById') return ok(clone(findRule(id)))
      if (url.pathname === '/mes/stkIo/list') {
        const rows = clone(state.bills.filter((row) => row.billNo === url.searchParams.get('billNo')))
        if (options.ambiguousBills && rows.length) rows.push(clone(rows[0]))
        return ok({ records: rows })
      }
      if (url.pathname === '/mes/stkIo/queryById') {
        const row = clone(state.bills.find((item) => item.id === id))
        if (options.foreignBill && row) row.remark = 'somebody else'
        if (options.apiOnlyVoid && row && state.voidAttempts) {
          row.isVoided = 1
          row.billStage = '0'
        }
        return ok(row)
      }
      if (url.pathname === '/mes/stkIo/queryEntryByMainId') {
        let entries = clone(state.entries.filter((row) => row.mid === id))
        if (options.phantomApiEntry && entries.length === 0 && state.bills.some((row) => row.id === id)) {
          entries = clone(state.phantomEntries.filter((row) => row.mid === id))
        }
        if (options.emptyEntries) entries = []
        if (options.unsafeEntryId && entries[0]) entries[0].id = Number.MAX_SAFE_INTEGER + 1
        return options.malformedEntries ? ok({ unexpected: entries }) : ok(entries)
      }
      throw new Error(`Unexpected GET ${path}`)
    },
    async postBusiness (path, body) {
      req('POST', path, body)
      if (path === '/mes/wmsWareHouse/add') {
        state.warehouses.push({ ...clone(body), id: nextId(), tenantId: '1', deleted: 0 })
        if (options.warehouseResponseLost) throw new Error('Warehouse committed; response lost')
        return ok('created warehouse')
      }
      if (path === '/mes/wmsHouseArea/add') {
        state.areas.push({ ...clone(body), id: nextId(), tenantId: '1', deleted: 0 })
        return ok('created area')
      }
      if (path === '/mes/wms-house-location/create') {
        const id = nextId()
        state.locations.push({ ...clone(body), id, tenantId: '1', deleted: 0 })
        return ok(id)
      }
      if (path === '/mes/basMaterial/add') {
        const id = nextId()
        state.materials.push({ ...clone(body), id, tenantId: '1', deleted: 0 })
        if (options.materialResponseLost) throw new Error('Material committed; response lost')
        return ok(id)
      }
      if (path === '/mes/fillRule/add') {
        state.rules.push({
          ...clone(body), id: 'a'.repeat(32), tenantId: '1', versionNo: 1,
          status: 'DRAFT', publishedTime: null
        })
        if (options.ruleResponseLost) throw new Error('Rule committed; response lost')
        return ok('created rule; not an identity')
      }
      if (path === '/mes/stkIo/add/save') {
        const id = nextId()
        const { stkIoEntryList, stkIoDistributionList: _distribution, stkIoBomList: _bom, ...fields } = body
        const main = {
          ...clone(fields), id, tenantId: '1', billStage: '12', isEffective: 0,
          isClosed: 0, isVoided: 0, effectiveTime: null, processInstanceId: null, bpmiInstanceId: null,
          srcBillType: null, srcBillId: null, deleted: 0
        }
        if (options.effectiveDraft) { main.billStage = '34'; main.isEffective = 1 }
        state.bills.push(main)
        for (const item of stkIoEntryList) {
          state.entries.push({
            ...clone(item), id: nextId(), tenantId: '1', mid: id, billNo: body.billNo,
            inStockTime: options.executedDraft ? '2026-10-12 14:00:00' : null,
            executedQty: options.executedDraft ? 1 : null, srcBillType: null, srcBillId: null, deleted: 0
          })
        }
        if (options.phantomApiEntry) {
          state.phantomEntries = clone(state.entries)
          state.entries = []
        }
        if (options.inventoryMutation === 'save') mutateInventory()
        if (options.outlookMutation) {
          state.outlook.push({ id: nextId(), tenantId: '1', materialId: state.materials[0].id, otherInQty: 1 })
        }
        if (options.saveResponseLost) throw new Error('Draft committed; response lost')
        return ok('saved; not an identity')
      }
      throw new Error(`Forbidden/unexpected POST ${path}`)
    },
    async putBusiness (path, body) {
      req('PUT', path, body)
      if (path.startsWith('/mes/fillRule/publish/')) {
        const row = findRule(path.split('/').at(-1))
        row.status = 'PUBLISHED'
        row.publishedTime = NOW
        if (options.publishMutation) row.ruleName = 'MODIFIED-DURING-PUBLISH'
        return ok('published')
      }
      if (path.startsWith('/mes/fillRule/executeRuleByCode/')) {
        const allocated = number()
        if (options.sequenceResponseLost) throw new Error('Sequence committed; response lost')
        return ok(allocated)
      }
      if (path === '/mes/fillRule/edit') {
        const original = findRule(body.id)
        if (options.overwritePublished) {
          Object.assign(original, clone(body))
        } else {
          state.rules.push({
            ...clone(original), ...clone(body), id: 'b'.repeat(32),
            versionNo: 2, status: 'DRAFT', publishedTime: null
          })
        }
        if (options.historyMainChange) state.bills[0].billNo = 'RECOMPUTED-BY-BUG'
        if (options.historyEntryChange) state.entries[0].billNo = 'RECOMPUTED-BY-BUG'
        if (options.historyEntryIdentityChange) state.entries[0].id = nextId()
        if (options.historyBillDateChange) state.bills[0].billDate = '2026-10-11'
        return ok('edited')
      }
      if (path === '/mes/stkIo/void') {
        state.voidAttempts++
        if (options.voidBusinessFailure) return { code: 2010100007, msg: 'Draft cannot be voided' }
        if (!options.voidNoop && !options.apiOnlyVoid) {
          const row = state.bills.find((item) => item.id === body.id)
          row.billStage = '0'
          row.isVoided = 1
        }
        if (options.resetSequenceOnVoid) state.sequences[0].v = 0
        if (options.inventoryMutation === 'void') mutateInventory()
        if (options.voidResponseLost) throw new Error('Void committed; response lost')
        return ok('voided')
      }
      throw new Error(`Forbidden/unexpected PUT ${path}`)
    },
    async deleteBusiness (path) {
      req('DELETE', path)
      throw new Error(`Audit deletion is forbidden ${path}`)
    }
  }
  function mutateInventory () {
    const row = {
      id: nextId(), tenantId: '1', materialId: state.materials[0].id,
      warehouseId: state.warehouses[0].id, qty: 0, availableQty: 0, lockQty: 0
    }
    row[options.inventoryField || 'qty'] = 1
    state.inventory.push(row)
  }
  const encode = (rows) => rows.map((row) => [JSON.stringify(row)])
  const literal = (sql, column) => new RegExp(`${column}\\s*=\\s*'([^']*)'`).exec(sql)?.[1]
  const read = async (sql) => {
    state.sql.push(sql)
    assert(!/\b(INSERT|UPDATE|DELETE|REPLACE|DROP|TRUNCATE|ALTER)\b/i.test(sql), 'SQL must stay read-only')
    if (options.dbUnavailable) return { available: false, rows: [] }
    if (options.dbError) throw new Error('SQL evidence failed')
    const isAudit = record.numberingClosure?.attempts.length > 0 &&
      (/ORDER BY version_no,id/.test(sql) && !sql.includes('1=0') &&
        (options.ruleResponseLost || options.warehouseResponseLost || options.saveResponseLost ||
          options.voidResponseLost || state.allocations === 3 || state.voidAttempts > 0))
    if (isAudit) state.audits++
    if (options.auditReadFailure && isAudit && state.allocations === 3) throw new Error('Audit read failed')
    if (sql.includes('JOIN system_tenant')) {
      return { available: true, rows: options.foreignTenant ? [] : [['10', '1', SETTINGS.tenantName]] }
    }
    if (sql.includes("'rule',COUNT(*)")) {
      return { available: true, rows: ['rule', 'prefix-rule', 'sequence', 'bill', 'warehouse', 'area', 'location', 'material']
        .map((kind) => [kind, (options.collision && kind === 'sequence') ||
          (options.rulePrefixCollision && kind === 'prefix-rule') ? '1' : '0']) }
    }
    if (sql.includes('WHERE 1=0')) {
      if (options.schemaMissing) throw new Error('Unknown column executed_qty')
      return { available: true, rows: [] }
    }
    if (sql.includes('FROM mes_wms_ware_house')) {
      const rows = []
      for (const [kind, values, codeField, markField] of [
        ['warehouse', state.warehouses, 'code', 'mark'], ['area', state.areas, 'areaCode', 'remark'],
        ['location', state.locations, 'locationCode', 'remark'], ['material', state.materials, 'code', 'remark']
      ]) {
        for (const row of values) {
          const obj = { id: row.id, tenantId: row.tenantId, code: row[codeField], mark: row[markField], deleted: row.deleted }
          if (kind === 'area' || kind === 'location') obj.warehouseId = row.houseId
          if (kind === 'location') obj.areaId = row.areaId
          if (kind === 'material') { obj.unitId = row.unitId; obj.inventoryNature = row.inventoryNature }
          if (options.foreignMasterDb && kind === 'material') obj.tenantId = '2'
          if (options.foreignAreaParent && kind === 'area') obj.warehouseId = '123'
          if (options.missingAreaParent && kind === 'area') obj.warehouseId = null
          if (options.deletedMaster && kind === 'warehouse') obj.deleted = 1
          rows.push([kind, JSON.stringify(obj)])
          if (options.duplicateMaster && kind === 'warehouse') rows.push([kind, JSON.stringify(obj)])
        }
      }
      return { available: true, rows }
    }
    if (sql.includes("'inventory-count'")) {
      const rows = []
      for (const [kind, values] of [['inventory', state.inventory], ['outlook', state.outlook]]) {
        if (!(options.missingCount && kind === 'inventory')) rows.push([`${kind}-count`, String(values.length)])
        if (!(options.truncatedStockRows && kind === 'inventory')) {
          rows.push(...values.map((row) => [`${kind}-row`, JSON.stringify(row)]))
        }
      }
      return { available: true, rows }
    }
    if (sql.includes('FROM mes_sys_fill_rule')) return { available: true, rows: encode(clone(state.rules)) }
    if (sql.includes('FROM mes_bas_sequence')) {
      const rows = clone(state.sequences)
      if (options.foreignSequence && rows[0]) rows[0].tenantId = '2'
      return { available: true, rows: encode(rows) }
    }
    if (sql.includes('FROM mes_stk_io_entry')) {
      return { available: true, rows: encode(clone(state.entries.filter((row) => row.mid === literal(sql, 'mid')))) }
    }
    if (sql.includes('FROM mes_stk_io')) {
      const rows = sql.includes('remark=') ? state.bills : state.bills.filter((row) => row.billNo === literal(sql, 'bill_no'))
      return { available: true, rows: encode(clone(rows)) }
    }
    throw new Error(`Unexpected SQL ${sql}`)
  }
  const dependencies = {
    config: clone(SETTINGS), env: { CFOR_E2E_WRITE_FIXTURES: 'true' },
    randomUUID: () => UUID, runReadOnlySql: read,
    now: () => {
      state.clockCalls++
      return options.crossMidnight && state.allocations === 1
        ? Date.parse('2026-10-13T00:00:01+08:00') : NOW
    },
    assertLocalWriteSafety: async (caseRecord) => {
      state.safetyCalls++
      assert.equal(caseRecord, record)
      if (options.unsafeSafety) throw new Error('BLOCKED: active-triggers must be 0')
    }
  }
  const run = () => runInitNumberingClosure({ api, caseRecord: record }, dependencies)
  return { state, record, api, dependencies, run, writes }
}

const messages = (error) => [error.message, ...(error.errors || []).flatMap((item) => messages(item))].join('\n')
async function fails (h, pattern) {
  let caught
  try { await h.run() } catch (error) { caught = error }
  assert(caught, 'Expected failure instead of a fabricated successful closure')
  assert.match(messages(caught), pattern)
  assert.notEqual(h.record.numberingClosure?.executed, true)
  assertNoDangerousCleanup(h)
  return caught
}
function assertNoDangerousCleanup (h) {
  assert(h.writes().every((row) => row.method !== 'DELETE' &&
    !/\/(submit|check|execute|edit\/save|updateExecuteQty|complete-inbound)$/.test(row.path)))
  assert(h.state.sql.every((sql) => !/\b(INSERT|UPDATE|DELETE|REPLACE|TRUNCATE|ALTER|DROP)\b/i.test(sql)))
}

test('PB011 uses real-helper API contracts for draft/void/version/sequence and retains all audit data', async () => {
  const h = harness()
  const result = await h.run()
  assert.equal(result.executed, true)
  assert.deepEqual(result.bills.map((bill) => bill.state), ['VOIDED', 'DRAFT'])
  assert.deepEqual(result.numbers.map((row) => row.sequence), [1, 2, 1])
  assert.equal(result.numbers[0].key, result.numbers[1].key)
  assert.notEqual(result.numbers[1].key, result.numbers[2].key)
  assert.equal(h.state.rules.length, 2)
  assert(h.state.rules.every((row) => row.status === 'PUBLISHED'))
  assert.notEqual(result.prefixes[0], result.prefixes[1])
  assert(result.prefixes.every((prefix) => !prefix.includes('TENANT')))
  assert.equal(result.retention.completed, true)
  assert.equal(result.retention.deleted, false)
  assert.equal(result.retention.rules.length, 2)
  assert.equal(result.retention.resources.length, 4)
  assert.equal(result.retention.bills.length, 2)
  assert.equal(result.retention.entries.length, 2)
  assert.equal(result.retention.sequences.length, 2)
  assert.deepEqual(result.retention.draftIds, [result.bills[1].id])
  assert(result.inventory.length >= 6)
  assert(result.inventory.every((snapshot) => snapshot.inventory.count === 0 && snapshot.outlook.count === 0))
  assert.equal(h.state.safetyCalls, 1)
  assert.equal(h.state.voidAttempts, 1)
  assert.equal(h.record.status, undefined)
  for (const name of Object.values(initNumberingClosureChecks)) {
    assert.equal(h.record.checks.filter((row) => row.name === name && row.passed === true).length, 1, name)
  }
  for (const write of h.writes().filter((row) => row.path.startsWith('/mes/stkIo/'))) {
    assert(['/mes/stkIo/add/save', '/mes/stkIo/void'].includes(write.path))
    if (write.path.endsWith('/save')) {
      assert.equal(write.body.stockIoType, '199')
      assert.equal(write.body.isAuto, 0)
      assert.equal(write.body.stkIoEntryList[0].isQc, 0)
      assert.deepEqual(write.body.stkIoBomList, [])
      assert.deepEqual(write.body.stkIoDistributionList, [])
      assert(!Object.hasOwn(write.body, 'srcBillType'))
    }
  }
  assertNoDangerousCleanup(h)
})

test('PB011 evidence mapping does not claim UI, arbitrary dates, or a second tenant', () => {
  assert.deepEqual(Object.keys(initNumberingClosureEvidence['PB011-001']), ['1', '4'])
  assert.equal(initNumberingClosureEvidence['PB011-001'][4].checks.length, 6)
  assert(initNumberingClosurePrerequisites.some((value) => value.includes('CFOR_E2E_WRITE_FIXTURES=true')))
})

for (const [name, configure, pattern] of [
  ['opt-in disabled', (h) => { h.dependencies.env = {} }, /CFOR_E2E_WRITE_FIXTURES/],
  ['remote target', (h) => { h.dependencies.config.target = 'production' }, /local/],
  ['wrong tenant', (h) => { h.dependencies.config.tenantId = '2' }, /租户/],
  ['wrong tenant name', (h) => { h.dependencies.config.tenantName = 'Other' }, /租户/],
  ['remote web', (h) => { h.dependencies.config.webBase = 'http://example.com:9151' }, /9151/],
  ['remote API prefix', (h) => { h.dependencies.config.apiUrl = 'http://example.com:48083/admin-api' }, /credential-free/],
  ['URL credentials', (h) => { h.dependencies.config.apiBase = 'http://user:secret@127.0.0.1:48083' }, /credential-free/],
  ['wrong database', (h) => { h.dependencies.config.db.name = 'production' }, /Database assertions/],
  ['unsafe marker', (h) => { h.dependencies.randomUUID = () => "' OR 1=1" }, /UUID/]
]) {
  test(`PB011 blocks ${name} before reads or writes`, async () => {
    const h = harness()
    configure(h)
    await fails(h, pattern)
    assert.equal(h.state.requests.length, 0)
    assert.equal(h.state.sql.length, 0)
  })
}

for (const [name, options, pattern] of [
  ['unavailable DB', { dbUnavailable: true }, /Database evidence unavailable/],
  ['failed SQL', { dbError: true }, /SQL evidence failed/],
  ['unsafe scheduled jobs', { unsafeSafety: true }, /active-triggers/],
  ['unauthenticated user', { permissionDenied: true }, /business failure/],
  ['foreign authenticated tenant', { foreignTenant: true }, /deep-equal/],
  ['prefix collision', { collision: true }, /deep-equal/],
  ['unconsumed prefix already referenced by another rule', { rulePrefixCollision: true }, /deep-equal/],
  ['missing schema migration', { schemaMissing: true }, /Unknown column executed_qty/],
  ['missing enabled unit', { noUnits: true }, /Missing enabled unit/]
]) {
  test(`PB011 blocks ${name} before any mutation`, async () => {
    const h = harness(options)
    await fails(h, pattern)
    assert.equal(h.writes().length, 0)
  })
}

for (const [name, options, pattern] of [
  ['unsafe warehouse numeric identity', { unsafeWarehouseId: true }, /unsafe numeric ID/],
  ['foreign material API ownership', { foreignMaterial: true }, /所有权/],
  ['foreign material SQL ownership', { foreignMasterDb: true }, /tenant mismatch/],
  ['foreign area parent', { foreignAreaParent: true }, /123/],
  ['missing area parent', { missingAreaParent: true }, /Master warehouse parent/],
  ['deleted master', { deletedMaster: true }, /Audit resource was deleted/],
  ['ambiguous master', { duplicateMaster: true }, /Ambiguous private resource/],
  ['ambiguous rules', { ambiguousRules: true }, /Rule list\/SQL count mismatch/],
  ['rule mutated during publish', { publishMutation: true }, /MODIFIED-DURING-PUBLISH/],
  ['ambiguous drafts', { ambiguousBills: true }, /unique formal list row/],
  ['foreign draft ownership', { foreignBill: true }, /somebody else/],
  ['empty entries', { emptyEntries: true }, /must not be empty/],
  ['API entry with no persisted row', { phantomApiEntry: true }, /Persisted WMS entries must not be empty/],
  ['malformed entries', { malformedEntries: true }, /未返回数组/],
  ['unsafe entry numeric identity', { unsafeEntryId: true }, /unsafe numeric ID/],
  ['auto-effective draft', { effectiveDraft: true }, /Formal WMS state mismatch/],
  ['already executed entry', { executedDraft: true }, /Draft entry was executed/]
]) {
  test(`PB011 rejects ${name} without proceeding to void`, async () => {
    const h = harness(options)
    await fails(h, pattern)
    assert.equal(h.state.voidAttempts, 0)
    assert(h.writes().length > 0)
    assert.equal(h.record.numberingClosure.retention.policy, 'read-only-audit-retention')
  })
}

for (const [name, options, pattern] of [
  ['HTTP-success business rejection', { voidBusinessFailure: true }, /business failure/],
  ['no-op void', { voidNoop: true }, /Formal WMS state mismatch/],
  ['API-only void with unchanged persisted state', { apiOnlyVoid: true }, /Formal WMS state mismatch/],
  ['sequence reset during void', { resetSequenceOnVoid: true }, /Persisted sequence differs/],
  ['foreign sequence', { foreignSequence: true }, /Sequence tenant mismatch/],
  ['recycled allocation', { recycle: true }, /strictly|严格递增/],
  ['skipped allocation', { skipNumber: true }, /严格递增/],
  ['wrong server date', { serverWrongDay: true }, /Server number date differs/],
  ['cross-midnight execution', { crossMidnight: true }, /crossed midnight/],
  ['published v1 overwritten', { overwritePublished: true }, /exactly one new draft/],
  ['v2 published but runtime still selects v1', { staleV2: true }, /published version mismatch/],
  ['historical main number recomputed', { historyMainChange: true }, /RECOMPUTED|uniquely persisted|number\/identity/],
  ['historical entry number recomputed', { historyEntryChange: true }, /Historical entry number changed/],
  ['historical entry identity replaced', { historyEntryIdentityChange: true }, /Historical entry identity changed/],
  ['historical bill date changed', { historyBillDateChange: true }, /Historical bill date changed/]
]) {
  test(`PB011 rejects ${name} and never reports a successful closure`, async () => {
    await fails(harness(options), pattern)
  })
}

for (const field of ['qty', 'availableQty', 'lockQty', 'holdQty', 'frozenQty', 'pendingPutawayQty', 'cost']) {
  test(`PB011 SQL catches ${field} stock mutation even with no inventory API query`, async () => {
    const h = harness({ inventoryMutation: 'save', inventoryField: field })
    await fails(h, /deep-equal/)
    assert.equal(h.state.voidAttempts, 0)
    assert.equal(h.record.numberingClosure.retention.completed, false)
    assert(!h.state.requests.some((row) => /inventory/i.test(row.path)))
    assert.equal(h.state.inventory.length, 1)
  })
}

for (const [name, options, pattern] of [
  ['void stock mutation', { inventoryMutation: 'void' }, /deep-equal/],
  ['outlook changed', { outlookMutation: true }, /deep-equal/],
  ['missing stock count sentinel', { missingCount: true }, /Missing inventory count sentinel/],
  ['truncated stock evidence', { inventoryMutation: 'save', truncatedStockRows: true }, /Incomplete inventory rows/]
]) {
  test(`PB011 rejects ${name} instead of treating empty collections as proof`, async () => {
    await fails(harness(options), pattern)
  })
}

for (const [name, options, expected] of [
  ['warehouse', { warehouseResponseLost: true }, { resources: 1, rules: 0, bills: 0 }],
  ['material', { materialResponseLost: true }, { resources: 4, rules: 0, bills: 0 }],
  ['rule', { ruleResponseLost: true }, { resources: 4, rules: 1, bills: 0 }],
  ['sequence', { sequenceResponseLost: true }, { resources: 4, rules: 1, bills: 0 }],
  ['draft', { saveResponseLost: true }, { resources: 4, rules: 1, bills: 1 }],
  ['void', { voidResponseLost: true }, { resources: 4, rules: 1, bills: 1 }]
]) {
  test(`PB011 discovers committed ${name} after response loss without retrying or destructive cleanup`, async () => {
    const h = harness(options)
    const error = await fails(h, /committed; response lost/)
    assert.equal(error.numberingEvidence, h.record.numberingClosure)
    const retained = error.numberingEvidence.retention
    assert.equal(retained.completed, true)
    for (const [key, count] of Object.entries(expected)) assert.equal(retained[key].length, count, key)
    if (name === 'draft' || name === 'void') {
      assert.equal(retained.sequences.length, 1)
      assert.equal(retained.sequences[0].v, 1)
      assert.equal(retained.entries.length, 1)
    }
    if (name === 'sequence') {
      assert.equal(retained.sequences.length, 1)
      assert.equal(retained.sequences[0].v, 1)
      assert.equal(h.state.allocations, 1)
    }
    assert.equal(h.writes().filter((row) => row.path === '/mes/stkIo/add/save').length, expected.bills)
    assert.equal(h.state.voidAttempts, name === 'void' ? 1 : 0)
  })
}

test('PB011 read-only audit failure fails an otherwise successful closure', async () => {
  const h = harness({ auditReadFailure: true })
  const error = await fails(h, /Audit read failed/)
  assert(error instanceof AggregateError)
  assert.equal(h.record.numberingClosure.retention.completed, false)
  assert.equal(h.record.numberingClosure.retention.errors[0].stage, 'rules')
  assert.equal(h.record.checks.some((row) => row.name === initNumberingClosureChecks.retention && row.passed), false)
  assert.equal(h.state.bills.length, 2)
  assert.equal(h.state.sequences.length, 2)
})

test('PB011 preserves both original business failure and retention errors', async () => {
  const h = harness({ inventoryMutation: 'void' })
  const error = await fails(h, /deep-equal/)
  assert(error instanceof AggregateError)
  assert(error.errors.length >= 2)
  assert.equal(error.numberingEvidence.retention.completed, false)
  assert(error.numberingEvidence.retention.errors.some((row) => row.stage === 'inventory'))
  assert.equal(h.state.inventory.length, 1)
  assert.equal(h.state.sequences.length, 1)
})

test('PB011 rejects a different case without touching dependencies', async () => {
  const h = harness()
  await assert.rejects(() => runInitNumberingClosure({
    api: h.api, caseRecord: h.record, caseId: 'MES-PROD-004'
  }, h.dependencies), /Unsupported numbering closure case/)
  assert.equal(h.state.requests.length, 0)
  assert.equal(h.state.sql.length, 0)
})
