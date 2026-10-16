import assert from 'node:assert/strict'
import test from 'node:test'
import { assertManualOqcScope, withManualOqcScenario } from '../fixtures/quality-manual-scenario.mjs'

const settings = {
  target: 'local', tenantId: '1', tenantName: 'CFOR 标准平台',
  apiBase: 'http://127.0.0.1:48083', webBase: 'http://127.0.0.1:9151',
  db: { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard' }
}
const dependencies = { config: settings, assertLocalWriteSafety: async () => {} }
function fixture () {
  let configuration = { is_auto_check: true, unrelated: 'keep' }
  const policies = []
  const dictionary = [
    { id: '10', value: 'MesStkIo:201', label: '销售出库', dictType: 'bill_type',
      status: 0, remark: 'existing' }
  ]
  const calls = []
  const api = {
    tenantIdByName: async () => '1',
    getBusiness: async (path) => {
      if (path.startsWith('/system/config/get')) {
        return { code: 0, data: { configData: JSON.stringify(configuration) } }
      }
      if (path.startsWith('/system/dict-data/type')) {
        return { code: 0, data: dictionary }
      }
      const url = new URL(path, 'http://localhost')
      if (path.startsWith('/mes/basBillOptions/list')) {
        return { code: 200, success: true, data: { records: policies.filter((row) =>
          row.billType === url.searchParams.get('billType')) } }
      }
      return { code: 200, success: true, data: policies.find((row) => row.id === url.searchParams.get('id')) }
    },
    postBusiness: async (path, body) => {
      calls.push({ path, body })
      if (path.startsWith('/system/config/save')) configuration = JSON.parse(body.configData)
      else {
        policies.push({ ...body, id: String(policies.length + 1) })
        if (!dictionary.some((row) => row.value === body.billType)) {
          dictionary.push({
            id: String(100 + dictionary.length), value: body.billType,
            label: body.billTypeLabel, dictType: 'bill_type', status: 0,
            remark: '由 MES 单据选项维护页自动创建'
          })
        }
      }
      return { code: 200, success: true }
    },
    deleteBusiness: async (path) => {
      calls.push({ path })
      const id = new URL(path, 'http://localhost').searchParams.get('id')
      if (path.startsWith('/system/dict-data/delete')) {
        dictionary.splice(dictionary.findIndex((row) => row.id === id), 1)
      } else {
        policies.splice(policies.findIndex((row) => row.id === id), 1)
      }
      return { code: 200, success: true }
    }
  }
  return {
    api, policies, calls, record: { checks: [] },
    readConfig: () => configuration,
    dictionary,
    changeConfig: (value) => { configuration = value }
  }
}
const scenarioDependencies = (f) => ({
  ...dependencies,
  runReadOnlySql: async (sql) => {
    const value = sql.match(/value = '([^']+)'/)?.[1]
    const row = f.dictionary.find((item) => item.value === value)
    return { rows: row ? [[row.id, row.dictType, row.value, row.label, row.status, row.remark]] : [] }
  }
})

test('manual OQC rejects production, wrong tenant and remote database before writes', () => {
  for (const change of [
    { target: 'production' }, { tenantId: '2' },
    { db: { ...settings.db, name: 'production' } },
    { apiBase: 'http://example.com:48083' }
  ]) assert.throws(() => assertManualOqcScope({ ...settings, ...change }))
})

test('manual OQC restores only its setting and removes only its temporary policies', async () => {
  const f = fixture()
  const value = await withManualOqcScenario(f.api, f.record, async () => {
    assert.equal(f.readConfig().is_auto_check, false)
    assert.equal(f.policies.length, 2)
    f.changeConfig({ ...f.readConfig(), unrelated: 'user-edit' })
    return 'verified'
  }, scenarioDependencies(f))
  assert.equal(value, 'verified')
  assert.deepEqual(f.readConfig(), { is_auto_check: true, unrelated: 'user-edit' })
  assert.equal(f.policies.length, 0)
  assert.equal(f.dictionary.some((row) => row.value === 'MesQualityInspection'), false)
  assert.equal(f.record.checks.every((row) => row.passed), true)
  assert.equal(f.calls[0].body.billTypeLabel, '销售出库')
})

test('failed OQC still restores configuration and cleans temporary policies', async () => {
  const f = fixture()
  await assert.rejects(withManualOqcScenario(f.api, f.record, async () => {
    throw new Error('scenario failure')
  }, scenarioDependencies(f)), /scenario failure/)
  assert.equal(f.readConfig().is_auto_check, true)
  assert.equal(f.policies.length, 0)
})

test('OQC never overwrites a nonmanual existing approval policy', async () => {
  const f = fixture()
  f.policies.push({ id: 'existing', billType: 'MesStkIo:201', mbillApprovalType: '2' })
  await assert.rejects(withManualOqcScenario(f.api, f.record, async () => {}, scenarioDependencies(f)),
    /existing MesStkIo:201 policy differs/)
  assert.equal(f.calls.length, 0)
})

test('cleanup does not delete a policy modified by another user', async () => {
  const f = fixture()
  await assert.rejects(withManualOqcScenario(f.api, f.record, async () => {
    f.policies[0].mbillApprovalType = '2'
  }, scenarioDependencies(f)), /cleanup failed/)
  assert.equal(f.readConfig().is_auto_check, true)
  assert.equal(f.policies.length, 1)
  assert.equal(f.policies[0].mbillApprovalType, '2')
  assert.equal(f.record.checks.at(-1).passed, false)
})
