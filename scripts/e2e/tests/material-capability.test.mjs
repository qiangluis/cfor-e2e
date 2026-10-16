import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  assertScope,
  cases,
  exactId,
  isOpenBusinessReference,
  mapCatalog,
  materialBody,
  MaterialCapabilityFixtures,
  orderBody,
  runCase
} from '../fixtures/material-capability.mjs'

const local = { target: 'local', tenantId: '1', tenantName: 'CFOR 标准平台',
  apiBase: 'http://127.0.0.1:48083', webBase: 'http://127.0.0.1:9151', db: { name: 'cfor_admin_standard' } }
const record = () => ({ id: 'PB032-006', checks: [], evidence: [], notes: [] })
const marker = 'E2E-PB032006-UNIT-TEST'
const success = (data) => ({ code: 0, data })

test('only PB032-006 and exact IDs/local tenant endpoints are authorized', () => {
  assert.deepEqual(cases, ['PB032-006'])
  assert.doesNotThrow(() => assertScope(local))
  for (const changes of [{ tenantId: '2' }, { target: 'production' }, { tenantName: 'other' },
    { db: { name: 'cfor_admin_saas' } }, { apiBase: 'http://127.0.0.1:48084' },
    { webBase: 'https://example.com:9151' }, { apiBase: 'http://user:secret@127.0.0.1:48083' }]) {
    assert.throws(() => assertScope({ ...local, ...changes }), /BLOCKED/)
  }
  assert.equal(exactId('9223372036854775807'), '9223372036854775807')
  for (const value of [9007199254740992, '1 OR 1', '', null]) assert.throws(() => exactId(value))
})
test('material and orders have valid dedicated stock/source/lead-time fields', () => {
  const material = materialBody('10', `${marker}-FG`, marker)
  assert.equal(material.source, 'mixed')
  assert.equal(material.inventoryNature, 'STOCK')
  assert.equal(material.leadTime, 1)
  assert.equal(material.bufferTime, 1)
  assert.equal(materialBody('10', `${marker}-RM`, marker, true).isMaterial, 'Y')
  assert.throws(() => materialBody('10', 'SHARED', marker), /ownership/)
  for (const kind of ['purchase', 'sale']) {
    const body = orderBody(kind, marker, { id: '11', unitId: '10' }, '12')
    assert.equal(body.items[0].productId, '11')
    assert.equal(body.totalPrice, body.items[0].count * body.items[0].productPrice)
    assert.equal(body.remark, marker)
    assert.equal(body.billNo.startsWith(marker), true)
  }
})
test('sales reference is open only when formal status fields remain open', () => {
  assert.equal(isOpenBusinessReference({ isClosed: 0, isVoided: 0, billStage: '12' }), true)
  assert.equal(isOpenBusinessReference({ isClosed: 0, isVoided: 0, billStage: '22' }), true)
  for (const reference of [
    { isClosed: 1, isVoided: 0, billStage: '34' },
    { isClosed: 0, isVoided: 1, billStage: '12' },
    { isClosed: 0, isVoided: 0, billStage: '34' }
  ]) {
    assert.equal(isOpenBusinessReference(reference), false)
  }
  assert.equal(isOpenBusinessReference(['id', 'material', '0', '0', '22']), true)
  assert.equal(isOpenBusinessReference(['id', 'material', '1', '0', '34']), false)
})
test('scope and database safety stop all fixture writes', async () => {
  let writes = 0
  const context = { caseId: 'PB032-006', caseRecord: record(), record: { environment: {} } }
  const dependencies = { config: local, createApiClient: () => ({ postBusiness: async () => { writes++ } }),
    assertLocalWriteSafety: async () => { throw new Error('unsafe jobs') } }
  await assert.rejects(runCase(context, dependencies), /unsafe jobs/)
  await assert.rejects(runCase(context, { ...dependencies, config: { ...local, tenantId: '2' } }), /BLOCKED/)
  assert.equal(writes, 0)
})
test('creation registers exact IDs before detail failure and recovers committed owned facts', async () => {
  const caseRecord = record()
  const fixtures = new MaterialCapabilityFixtures({
    postBusiness: async () => { throw new Error('response failed') }
  }, caseRecord, async () => ({ available: true, rows: [['21']] }))
  fixtures.marker = marker
  await assert.rejects(fixtures.create('material', materialBody('10', `${marker}-FG`, marker)), /response failed/)
  assert.equal(caseRecord.fixtures[0].id, '21')
  assert.equal(caseRecord.fixtures[0].status, 'creating')
})
test('shared or changed ownership refuses every mutation', async () => {
  let writes = 0
  const fixtures = new MaterialCapabilityFixtures({
    request: async () => { writes++ }, deleteBusiness: async () => { writes++ }
  }, record(), async () => ({ available: true, rows: [['21', '1', 'SHARED', marker]] }))
  fixtures.marker = marker
  const resource = { id: '21', kind: 'material', identity: `${marker}-FG` }
  fixtures.owned.push(resource)
  await assert.rejects(fixtures.reject(resource, 'purchased', '可采购能力'), /ownership mismatch/)
  await assert.rejects(fixtures.cleanup(), /Assertion failed/)
  assert.equal(writes, 0)
})
for (const code of [2010100009, 500, 2010100006, 0]) {
  test(`reference protection requires exact code not generic rejection (${code})`, async () => {
    const caseRecord = record()
    const body = { ...materialBody('10', `${marker}-FG`, marker), id: '21' }
    const fixtures = new MaterialCapabilityFixtures({
      getBusiness: async () => success(body),
      request: async (_method, _path, attempted) => {
        assert.equal(attempted.purchased, 'N')
        assert.equal(attempted.code, body.code)
        return { code, msg: '存货仍被未完成业务引用，不能关闭：可采购能力' }
      }
    }, caseRecord, async (sql) => ({ available: true,
      rows: sql.includes('SELECT id,tenant_id') ? [['21', '1', body.code, marker]] : [['21', 'Y']] }))
    fixtures.marker = marker
    const resource = { kind: 'material', id: '21', identity: body.code }
    if (code === 2010100009) await fixtures.reject(resource, 'purchased', '可采购能力')
    else await assert.rejects(fixtures.reject(resource, 'purchased', '可采购能力'), /Assertion failed/)
    assert.equal(caseRecord.capabilityAttempts.length, 1)
    assert.equal(caseRecord.checks[0].passed, true)
  })
}
test('a correct rejection code with changed database facts is a failure', async () => {
  let attempt = false
  const body = { ...materialBody('10', `${marker}-FG`, marker), id: '21' }
  const fixtures = new MaterialCapabilityFixtures({
    getBusiness: async () => success(body),
    request: async () => { attempt = true; return { code: 2010100009, msg: '可采购能力仍被未完成业务引用' } }
  }, record(), async (sql) => ({ available: true,
    rows: sql.includes('SELECT id,tenant_id') ? [['21', '1', body.code, marker]] : [['21', attempt ? 'N' : 'Y']] }))
  fixtures.marker = marker
  await assert.rejects(fixtures.reject({ id: '21', kind: 'material', identity: body.code }, 'purchased', '可采购能力'), /Assertion failed/)
})
test('finally cleans a material already created before the next prerequisite fails', async () => {
  const caseRecord = record()
  let material
  let creates = 0
  let removed = false
  const api = {
    getBusiness: async (pathname) => pathname.includes('list/enabled')
      ? success([{ unitId: '10' }]) : success(material),
    postBusiness: async (_pathname, body) => {
      if (++creates === 2) throw new Error('injected component failure')
      material = { ...body, id: '21' }
      return { code: 200, success: true, data: '21' }
    },
    deleteBusiness: async (pathname) => {
      assert.equal(pathname, '/mes/basMaterial/delete?id=21')
      removed = true
      return success(true)
    },
    get: async (_pathname, options) => {
      assert.deepEqual(options, { expectedBusinessRejection: {
        code: 500, message: '未找到对应数据', allowServiceCode: true
      } })
      return { code: 500, success: false, message: '未找到对应数据' }
    }
  }
  const result = await runCase({ caseId: cases[0], caseRecord, record: { environment: {} } }, {
    config: local, assertLocalWriteSafety: async () => {},
    login: async () => ({ token: 'unit-token', tenantId: '1' }),
    createApiClient: () => api,
    runReadOnlySql: async (sql) => ({ available: true,
      rows: sql.includes('SELECT id,tenant_id') ? [['21', '1', material.code, material.remark]]
        : sql.includes('SELECT id FROM') ? []
          : [...sql.matchAll(/SELECT '(\w+)'/g)].map((match) => [match[1], '0']) })
  })
  assert.equal(result.partial, true)
  assert.equal(removed, true)
  assert.equal(caseRecord.cleanup.passed, true)
  assert.equal(caseRecord.fixtures[0].status, 'cleaned')
  assert.equal(caseRecord.fixtures[1].status, 'not-created')
  assert.equal(caseRecord.remainingAssertions.length, 5)
})
test('cleanup removes production first, clears only owned default BOM, then deletes BOM and material', async () => {
  const caseRecord = record()
  const calls = []
  const parent = { id: '21', kind: 'material', identity: `${marker}-FG` }
  const bom = { id: '22', kind: 'bom', identity: `${marker}-BOM`, parentId: parent.id }
  const production = { id: '23', kind: 'production', identity: `${marker}-PROD` }
  let defaultProdBom = bom.id
  const api = {
    getBusiness: async () => success({ id: parent.id, code: parent.identity, remark: marker, defaultProdBom }),
    putBusiness: async (pathname, body) => {
      assert.equal(pathname, '/mes/basMaterial/edit')
      assert.equal(body.id, parent.id)
      assert.equal(body.defaultProdBom, '')
      defaultProdBom = ''
      calls.push('clear-owned-default')
      return success(true)
    },
    deleteBusiness: async (pathname) => { calls.push(pathname); return success(true) },
    get: async () => ({ code: 500, success: false, message: '未找到对应数据' })
  }
  const fixtures = new MaterialCapabilityFixtures(api, caseRecord, async (sql) => {
    const resource = [parent, bom, production].find((row) => sql.includes(`id='${row.id}'`))
    return { available: true, rows: sql.includes('SELECT id,tenant_id')
      ? [[resource.id, '1', resource.identity, marker]]
      : [...sql.matchAll(/SELECT '(\w+)'/g)].map((match) => [match[1], '0']) }
  })
  fixtures.marker = marker
  fixtures.owned.push(parent, bom, production)
  await fixtures.cleanup()
  assert.deepEqual(calls, [
    '/mes/prodOrder/delete?id=23', 'clear-owned-default',
    '/mes/wmsAssemble/delete?id=22', '/mes/basMaterial/delete?id=21'
  ])
  assert.equal(caseRecord.cleanup.passed, true)
  assert.ok(caseRecord.checks.every((row) => row.passed))
})
test('cleanup formally voids an effective sale order before deleting it', async () => {
  const caseRecord = record()
  const calls = []
  let detail = {
    id: '21',
    billNo: `${marker}-SO`,
    remark: marker,
    billStage: '34',
    isEffective: 1,
    isClosed: 1,
    isVoided: 0
  }
  const api = {
    getBusiness: async (pathname) => {
      assert.equal(pathname, '/erp/sale-order/get?id=21')
      return success(detail)
    },
    putBusiness: async (pathname, body) => {
      calls.push([pathname, body])
      assert.equal(pathname, '/erp/sale-order/void')
      assert.deepEqual(body, { id: '21' })
      detail = { ...detail, billStage: '12', isEffective: 0, isClosed: 0 }
      return success(true)
    },
    deleteBusiness: async (pathname) => {
      calls.push([pathname])
      assert.equal(pathname, '/erp/sale-order/delete?ids=21')
      return success(true)
    },
    get: async (pathname) => {
      assert.equal(pathname, '/erp/sale-order/get?id=21')
      return success(null)
    }
  }
  const fixtures = new MaterialCapabilityFixtures(api, caseRecord, async (sql) => ({
    available: true,
    rows: sql.includes('SELECT id,tenant_id')
      ? [['21', '1', `${marker}-SO`, marker]]
      : [...sql.matchAll(/SELECT '(\w+)'/g)].map((match) => [match[1], '0'])
  }))
  fixtures.marker = marker
  fixtures.owned.push({
    kind: 'sale',
    id: '21',
    identity: `${marker}-SO`,
    tenantId: '1',
    marker,
    status: 'created'
  })

  await fixtures.cleanup()

  assert.deepEqual(calls, [
    ['/erp/sale-order/void', { id: '21' }],
    ['/erp/sale-order/delete?ids=21']
  ])
  assert.equal(caseRecord.cleanup.passed, true)
  assert.equal(fixtures.owned[0].status, 'cleaned')
  assert.ok(caseRecord.checks.some((check) =>
    check.name === 'sale 通过正式作废接口回到编制态' && check.passed))
})
test('unresolved response recovery cannot silently claim successful cleanup', async () => {
  const fixtures = new MaterialCapabilityFixtures({}, record())
  fixtures.owned.push({ kind: 'material', status: 'creating' })
  await assert.rejects(fixtures.cleanup(), /Assertion failed/)
  assert.equal(fixtures.record.cleanup.passed, false)
})
test('all five catalog assertions remain GAP until verified and cleanup is required', () => {
  const caseRecord = record()
  mapCatalog(caseRecord, new Set([0, 1, 2]))
  assert.equal(caseRecord.catalogAssertions.length, 5)
  assert.equal(caseRecord.remainingAssertions.length, 2)
  assert.equal(caseRecord.readyCandidate, false)
  caseRecord.checks.push({ passed: true })
  caseRecord.cleanup = { passed: true }
  mapCatalog(caseRecord, new Set([0, 1, 2, 3, 4]))
  assert.equal(caseRecord.readyCandidate, true)
  caseRecord.checks.push({ passed: false })
  mapCatalog(caseRecord, new Set([0, 1, 2, 3, 4]))
  assert.equal(caseRecord.readyCandidate, false)
})
test('headed fixture preserves real outcomes, runtime layers and trace path; no shared edits or SQL writes', () => {
  const source = fs.readFileSync(new URL('../fixtures/material-capability.mjs', import.meta.url), 'utf8')
  assert.match(source, /finally \{[\s\S]*await fixtures\.cleanup\(\)/)
  assert.match(source, /tracing\.stop\(\{ path: trace \}\)/)
  assert.match(source, /caseOutcome\(\{ result, failedChecks/)
  assert.match(source, /isolated-headed-fixture-not-official-runner/)
  assert.match(source, /findMenuRouteByComponent\(permission\?\.menus, 'base\/material\/index'\)/)
  assert.match(source, /\/erp\/sale-order\/void/)
  assert.match(source, /isOpenBusinessReference\(refs\[0\]\)/)
  for (const layer of ['console', 'page', 'business-api', 'request']) assert.ok(source.includes(`'${layer}'`))
  assert.doesNotMatch(source, /(?:UPDATE|DELETE FROM|INSERT INTO)\s+\w+/)
  assert.doesNotMatch(source, /\/system\/config\/(?:update|create)|\/update-status|\/check['"`]/)
})
