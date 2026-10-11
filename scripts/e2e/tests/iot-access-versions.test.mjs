import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyIotAccessConfigVersions } from '../fixtures/iot-write-closure.mjs'

const harness = (omit = '') => {
  const product = {
    id: '9007199254740993', name: 'E2E-IOT-013-version', categoryId: 1,
    deviceType: 0, netType: 0, protocolType: 'mqtt', serializeType: 'json',
    locationType: 3, registerEnabled: false, description: 'fixture', accessConfigVersion: 1
  }
  let state = structuredClone(product)
  const calls = []
  return {
    product, calls,
    api: {
      async putBusiness (path, body) {
        assert.equal(path, '/iot/product/update')
        calls.push(body)
        const changed = ['deviceType', 'netType', 'protocolType', 'serializeType']
          .some((field) => field !== omit && state[field] !== body[field])
        state = { ...state, ...body, accessConfigVersion: state.accessConfigVersion + Number(changed) }
        return { code: 0, data: true }
      },
      async getBusiness () { return { code: 0, data: structuredClone(state) } }
    }
  }
}

test('IOT-013 verifies each access field independently, restores it and rejects no-op version bumps', async () => {
  const { api, product, calls } = harness()
  const record = { checks: [] }
  const saved = await verifyIotAccessConfigVersions(api, product, record)
  assert.equal(saved.accessConfigVersion, 6)
  assert.equal(calls.length, 6)
  for (const field of ['deviceType', 'netType', 'protocolType', 'serializeType']) {
    assert.equal(saved[field], product[field])
    assert.ok(record.checks.some((check) => check.name.includes(field) && check.passed))
  }
  assert.ok(record.checks.every((check) => check.passed))
})

for (const field of ['deviceType', 'netType', 'protocolType', 'serializeType']) {
  test(`IOT-013 cannot pass when ${field} changes without incrementing the version`, async () => {
    const { api, product } = harness(field)
    const record = { checks: [] }
    await assert.rejects(verifyIotAccessConfigVersions(api, product, record), new RegExp(field))
    assert.equal(record.checks.at(-1).passed, false)
  })
}

test('IOT-013 refuses a version bump caused by writing the same configuration', async () => {
  const { api, product } = harness()
  const read = api.getBusiness
  let reads = 0
  api.getBusiness = async () => {
    const response = await read()
    if (++reads === 6) response.data.accessConfigVersion++
    return response
  }
  const record = { checks: [] }
  await assert.rejects(verifyIotAccessConfigVersions(api, product, record), /同值更新/)
  assert.equal(record.checks.at(-1).passed, false)
})
