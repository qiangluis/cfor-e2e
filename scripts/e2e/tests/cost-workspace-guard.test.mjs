import assert from 'node:assert/strict'
import test from 'node:test'
import { protectSharedCostWorkspace } from '../suites/cost.mjs'

const record = () => ({ notes: [] })
const saveBody = () => ({
  accountingOrgId: 1, stateKey: 'unit-workspace', payloadJson: '{"draft":true}', version: 7
})

test('shared workspace guard does not forward PUT or advance the caller version', async () => {
  let handler
  const page = {
    route: async (pattern, callback) => {
      assert.equal(pattern, '**/cost/workspace-states/save')
      handler = callback
    }
  }
  const caseRecord = record()
  await protectSharedCostWorkspace(page, caseRecord)
  let receipt
  const body = saveBody()
  await handler({
    request: () => ({ method: () => 'PUT', postDataJSON: () => body }),
    continue: () => assert.fail('shared PUT must not reach the server'),
    fulfill: async (response) => { receipt = JSON.parse(response.body) }
  })
  assert.deepEqual(receipt.data, body)
  assert.equal(receipt.data.version, 7)
  assert.match(receipt.msg, /not persisted/)
  assert.deepEqual(caseRecord.guardedWorkspaceWrites, [{
    stateKey: body.stateKey, accountingOrgId: 1, version: 7, persisted: false
  }])
  assert.ok(caseRecord.notes.some((note) => note.includes('不计入保存验收证据')))
})

test('reused pages attribute guarded writes to the current case and still forward reads', async () => {
  let handler
  let registrations = 0
  const page = {
    route: async (_pattern, callback) => { registrations++; handler = callback }
  }
  const first = record()
  const second = record()
  await protectSharedCostWorkspace(page, first)
  await protectSharedCostWorkspace(page, second)
  assert.equal(registrations, 1)
  await handler({
    request: () => ({ method: () => 'PUT', postDataJSON: saveBody }),
    continue: () => assert.fail('shared PUT must not reach the server'),
    fulfill: async () => {}
  })
  assert.equal(first.guardedWorkspaceWrites, undefined)
  assert.equal(second.guardedWorkspaceWrites.length, 1)
  let continued = false
  await handler({
    request: () => ({ method: () => 'GET' }),
    continue: async () => { continued = true },
    fulfill: () => assert.fail('GET must not be substituted')
  })
  assert.equal(continued, true)
})

test('malformed guarded saves never receive successful persistence-shaped receipts', async () => {
  let handler
  await protectSharedCostWorkspace({
    route: async (_pattern, callback) => { handler = callback }
  }, record())
  for (const body of [null, { ...saveBody(), version: -1 }, { ...saveBody(), version: '7' }]) {
    await assert.rejects(() => handler({
      request: () => ({ method: () => 'PUT', postDataJSON: () => body }),
      continue: () => assert.fail('invalid PUT must not reach the server'),
      fulfill: () => assert.fail('invalid PUT must not get a successful receipt')
    }), /invalid save request/)
  }
})
