import assert from 'node:assert/strict'
import test from 'node:test'
import { createQualityApprovalAccounts } from '../fixtures/quality-bpm-approval.mjs'

const settings = {
  target: 'local',
  tenantId: '1',
  tenantName: 'CFOR 标准平台'
}

function harness (options = {}) {
  const calls = []
  const record = { accounts: [], evidence: [] }
  const users = [
    ['101', '0'],
    ['102', '0'],
    ['103', '1']
  ]
  const api = {
    async postBusiness (path, body) {
      calls.push({ method: 'POST', path, body })
      if (path === '/system/user/create') {
        const userId = String(200 + calls.filter((call) => call.path === path).length)
        return { code: 0, data: userId }
      }
      return { code: 0, data: true }
    },
    async putBusiness (path, body) {
      calls.push({ method: 'PUT', path, body })
      assert.equal(path, '/system/user/update-status')
      return { code: 0, data: true }
    }
  }
  const dependencies = {
    config: settings,
    runReadOnlySql: async (sql) => {
      if (sql.includes('FROM system_role')) {
        return { rows: [['11', 'apv_quality_inspector'], ['12', 'apv_quality_mgr'], ['13', 'apv_prod_mgr']] }
      }
      if (sql.includes('FROM system_users')) {
        return { rows: options.roleUsers || users }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    }
  }
  return { api, calls, record, dependencies }
}

test('isolates role candidates and restores existing accounts after cleanup', async () => {
  const h = harness()
  const accounts = await createQualityApprovalAccounts(h.api, h.record, h.dependencies)
  const createdIds = new Set(h.record.accounts.map((account) => account.userId))
  const suspensionCalls = h.calls.filter((call) =>
    call.method === 'PUT' && !createdIds.has(call.body.id))
  assert.deepEqual(suspensionCalls.map((call) => call.body), [
    { id: '101', status: 1 },
    { id: '102', status: 1 }
  ])
  assert.equal(h.record.evidence.length, 1)

  await accounts.cleanup()
  const restoreCalls = h.calls.filter((call) =>
    call.method === 'PUT' && ['101', '102'].includes(call.body.id))
  assert.deepEqual(restoreCalls.map((call) => call.body), [
    { id: '101', status: 1 },
    { id: '102', status: 1 },
    { id: '102', status: 0 },
    { id: '101', status: 0 }
  ])
  assert.deepEqual(h.calls.slice(-2).map((call) => call.body), [
    { id: '102', status: 0 },
    { id: '101', status: 0 }
  ])
})

test('restores already suspended accounts when setup fails', async () => {
  const h = harness()
  const originalPost = h.api.postBusiness
  let createCount = 0
  h.api.postBusiness = async (path, body) => {
    if (path === '/system/user/create' && ++createCount === 2) {
      throw new Error('second account creation failed')
    }
    return originalPost(path, body)
  }
  await assert.rejects(
    createQualityApprovalAccounts(h.api, h.record, h.dependencies),
    /second account creation failed/
  )
  assert.deepEqual(h.calls.filter((call) => call.method === 'PUT').map((call) => call.body), [
    { id: '201', status: 1 }
  ])
})
