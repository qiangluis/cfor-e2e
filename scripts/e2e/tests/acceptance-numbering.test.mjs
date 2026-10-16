import test from 'node:test'
import assert from 'node:assert/strict'
import { ensureAcceptanceNumbering } from '../fixtures/acceptance-numbering.mjs'

const config = {
  target: 'local', tenantId: '1', tenantName: 'CFOR 标准平台',
  webBase: 'http://127.0.0.1:9151', apiBase: 'http://127.0.0.1:48083',
  db: { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard' }
}
const record = () => ({ checks: [], notes: [], fixtures: [] })
const row = (code, status = 'PUBLISHED', effective = '1', id = 'old') =>
  [id, '1', code, '1', status, '{"prefix":"OLD"}', effective]

test('effective tenant or platform numbering is left untouched', async () => {
  for (const tenant of ['0', '1']) {
    const evidence = record()
    await ensureAcceptanceNumbering({
      postBusiness: async () => assert.fail('unexpected write'),
      putBusiness: async () => assert.fail('unexpected publish')
    }, evidence, ['fin_yshx_bill_no'], {
      config,
      runReadOnlySql: async () => ({ available: true, rows: [
        row('fin_yshx_bill_no').map((value, index) => index === 1 ? tenant : value)
      ] })
    })
    assert.equal(evidence.fixtures.length, 0)
    assert.equal(evidence.notes.length, 1)
  }
})

test('all existing rules are preflighted before any missing rule is created', async () => {
  for (const [status, effective] of [['DRAFT', '1'], ['DISABLED', '1'], ['PUBLISHED', '0']]) {
    await assert.rejects(ensureAcceptanceNumbering({
      postBusiness: async () => assert.fail('unexpected write')
    }, record(), ['fin_yshx_bill_no', 'batch_no'], {
      config,
      runReadOnlySql: async (sql) => ({ available: true, rows: sql.includes("'batch_no'")
        ? [row('batch_no', status, effective)] : [] })
    }), /not effective/)
  }
})

test('missing numbering is created, published and independently verified using historical parameters', async () => {
  const calls = []
  const evidence = record()
  let created
  let reads = 0
  await ensureAcceptanceNumbering({
    postBusiness: async (path, body) => {
      calls.push(path); created = { ...body, id: '1234567890abcdef1234567890abcdef' }
      return { code: 0, data: true }
    },
    putBusiness: async (path) => { calls.push(path); return { code: 200, success: true } },
    getBusiness: async (path) => {
      calls.push(path)
      return { code: 200, success: true, data: { ...created, tenantId: 1, status: 'PUBLISHED' } }
    }
  }, evidence, ['fin_yshx_bill_no'], {
    config,
    runReadOnlySql: async () => ({ available: true, rows: ++reads === 1 ? [] : [[
      created.id, '1', 'fin_yshx_bill_no', '1', reads === 2 ? 'DRAFT' : 'PUBLISHED', created.ruleParams, '1'
    ]] })
  })
  assert.deepEqual(JSON.parse(created.ruleParams), { prefix: 'YSHX-', period: 'yyMMdd-', seqLen: 3 })
  assert.equal(created.status, undefined)
  assert(created.effectiveFrom <= Date.now())
  assert.equal(calls[1], `/mes/fillRule/publish/${created.id}`)
  assert.equal(evidence.checks[0].passed, true)
  assert.equal(evidence.database.length, 3)
})

test('invalid local scope, unavailable database and unknown definitions cannot cause writes', async () => {
  const api = { postBusiness: async () => assert.fail('unexpected write') }
  for (const settings of [
    { ...config, target: 'production' }, { ...config, tenantId: '2' },
    { ...config, apiBase: 'http://192.168.110.252:48083' },
    { ...config, db: { ...config.db, name: 'cfor_admin_saas_standard' } }
  ]) {
    await assert.rejects(ensureAcceptanceNumbering(api, record(), ['batch_no'], { config: settings }))
  }
  await assert.rejects(ensureAcceptanceNumbering(api, record(), ['unknown'], { config }))
  await assert.rejects(ensureAcceptanceNumbering(api, record(), ['batch_no'], {
    config, runReadOnlySql: async () => ({ available: false, rows: [] })
  }), /must be available/)
})

test('missing payable write-off numbering uses the historical YFHX parameters', async () => {
  const evidence = record()
  let created
  let reads = 0
  await ensureAcceptanceNumbering({
    postBusiness: async (path, body) => {
      created = { ...body, id: 'abcdef1234567890abcdef1234567890' }
      return { code: 0, data: true }
    },
    putBusiness: async () => ({ code: 0 }),
    getBusiness: async () => ({ code: 0, data: { ...created, tenantId: 1, status: 'PUBLISHED' } })
  }, evidence, ['fin_yfhx_bill_no'], {
    config,
    runReadOnlySql: async () => ({ available: true, rows: ++reads === 1 ? [] : [[
      created.id, '1', 'fin_yfhx_bill_no', '1', reads === 2 ? 'DRAFT' : 'PUBLISHED',
      created.ruleParams, '1'
    ]] })
  })
  assert.deepEqual(JSON.parse(created.ruleParams), { prefix: 'YFHX-', period: 'yyMMdd-', seqLen: 3 })
  assert.equal(evidence.checks[0].passed, true)
})

test('API failures and foreign readback identities remain failures', async () => {
  for (const failure of ['create', 'identity']) {
    let created
    await assert.rejects(ensureAcceptanceNumbering({
      postBusiness: async (path, body) => {
        created = body
        return failure === 'create' ? { code: 500, message: '异常' } : { code: 0 }
      },
      putBusiness: async () => ({ code: 0 }),
      getBusiness: async () => ({ code: 0, data: { ...created, id: 'foreign', status: 'PUBLISHED' } })
    }, record(), ['batch_no'], {
      config, runReadOnlySql: async () => ({ available: true, rows: created ? [[
        '1234567890abcdef1234567890abcdef', '1', 'batch_no', '1', 'DRAFT', created.ruleParams, '1'
      ]] : [] })
    }))
  }
})
