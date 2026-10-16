import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanupCostScenarioReviewer } from '../fixtures/cost-scenario.mjs'

const clone = (value) => structuredClone(value)
const success = (data) => ({ code: 0, data: clone(data) })
const participants = {
  user: {
    idKey: 'UserId', nameKey: 'Username', deletedKey: 'Deleted',
    field: 'username', label: '账号'
  },
  role: {
    idKey: 'RoleId', nameKey: 'RoleCode', deletedKey: 'RoleDeleted',
    field: 'code', label: '角色'
  }
}

const harness = (key = 'reviewer') => {
  const fixture = {
    [`${key}UserId`]: '2110751742884233217',
    [`${key}Username`]: 'e2ecost_owned_cleanup',
    [`${key}RoleId`]: '2110751741709828097',
    [`${key}RoleCode`]: 'e2e_cost_reviewer_owned_cleanup'
  }
  const entities = {
    user: { id: fixture[`${key}UserId`], username: fixture[`${key}Username`] },
    role: { id: fixture[`${key}RoleId`], code: fixture[`${key}RoleCode`] }
  }
  const overrides = new Map()
  const calls = []
  const api = Object.fromEntries(['getBusiness', 'get', 'deleteBusiness'].map((method) => [
    method,
    async (request) => {
      const url = new URL(request, 'http://offline.invalid')
      const [, , type, action] = url.pathname.split('/')
      assert.ok(Object.hasOwn(participants, type), `Unexpected API: ${request}`)
      assert.equal(url.searchParams.get('id'), fixture[`${key}${participants[type].idKey}`])
      assert.equal(action, method === 'deleteBusiness' ? 'delete' : 'get')
      calls.push({ method, type, request })
      const override = overrides.get(`${method}:${type}`)
      if (override instanceof Error) throw override
      if (override !== undefined) return clone(override)
      if (method === 'deleteBusiness') {
        entities[type] = null
        return success(true)
      }
      return success(entities[type])
    }
  ]))
  return {
    key, fixture, entities, overrides, calls, api,
    run: (currentFixture = fixture) =>
      cleanupCostScenarioReviewer({ api, fixture: currentFixture, key })
  }
}

for (const key of ['reviewer', 'approvalReviewer', 'operatingReviewer']) {
  test(`${key} cleanup verifies deletion once and rechecks null on repeated or copied teardown`, async () => {
    const h = harness(key)
    await h.run()
    assert.equal(h.fixture[`${key}Deleted`], true)
    assert.equal(h.fixture[`${key}RoleDeleted`], true)
    assert.deepEqual(h.calls.map(({ method, type }) => `${method}:${type}`), [
      'getBusiness:user', 'deleteBusiness:user', 'get:user',
      'getBusiness:role', 'deleteBusiness:role', 'get:role'
    ])
    const snapshot = clone(h.fixture)
    for (const fixture of [h.fixture, { ...h.fixture }]) {
      const before = h.calls.length
      await h.run(fixture)
      assert.deepEqual(h.calls.slice(before).map(({ method, type }) => `${method}:${type}`),
        ['getBusiness:user', 'getBusiness:role'])
      assert.deepEqual(fixture, snapshot)
    }
    assert.equal(h.calls.filter(({ method }) => method === 'deleteBusiness').length, 2)
  })
}

test('cleanup retries a remaining role without deleting the already verified user again', async () => {
  const h = harness()
  const deletionFailure = new Error('unit role delete failed')
  h.overrides.set('deleteBusiness:role', deletionFailure)
  await assert.rejects(h.run, (error) => error === deletionFailure)
  assert.equal(h.fixture.reviewerDeleted, true)
  assert.equal(h.fixture.reviewerRoleDeleted, undefined)
  assert.equal(h.entities.user, null)
  assert.notEqual(h.entities.role, null)
  h.overrides.delete('deleteBusiness:role')
  const before = h.calls.length
  await h.run()
  assert.deepEqual(h.calls.slice(before).map(({ method, type }) => `${method}:${type}`), [
    'getBusiness:user', 'getBusiness:role', 'deleteBusiness:role', 'get:role'
  ])
  assert.equal(h.fixture.reviewerRoleDeleted, true)
})

for (const [type, definition] of Object.entries(participants)) {
  test(`${type} missing without an exact deletion flag is not treated as owned cleanup`, async () => {
    for (const flag of [undefined, false, 'true', 1]) {
      const h = harness()
      h.fixture.reviewerDeleted = true
      h.fixture.reviewerRoleDeleted = true
      h.entities.user = null
      h.entities.role = null
      h.fixture[`reviewer${definition.deletedKey}`] = flag
      await assert.rejects(h.run, new RegExp(`${definition.label}清理所有权不符`))
      assert.equal(h.calls.filter(({ method }) => method === 'deleteBusiness').length, 0)
    }
  })

  test(`${type} deletion flags never bypass live identity mismatches`, async () => {
    for (const mutation of [
      (entity) => { entity.id = '2110751742884233218' },
      (entity) => { entity[definition.field] = 'another-business-identity' }
    ]) {
      const h = harness()
      h.fixture.reviewerDeleted = true
      h.fixture.reviewerRoleDeleted = true
      if (type === 'role') h.entities.user = null
      mutation(h.entities[type])
      await assert.rejects(h.run, new RegExp(`${definition.label}清理所有权不符`))
      assert.equal(h.calls.filter(({ method }) => method === 'deleteBusiness').length, 0)
    }
  })

  test(`${type} registered deletion requires explicit null, not failed or malformed reads`, async () => {
    for (const payload of [
      { code: 0 }, { code: 0, data: undefined }, { code: 403, data: null },
      { code: 500, data: null }, { code: 0, success: false, data: null }, { data: null }
    ]) {
      const h = harness()
      h.fixture.reviewerDeleted = true
      h.fixture.reviewerRoleDeleted = true
      h.entities.user = null
      h.entities.role = null
      h.overrides.set(`getBusiness:${type}`, payload)
      await assert.rejects(h.run)
      assert.equal(h.calls.filter(({ method }) => method === 'deleteBusiness').length, 0)
    }
  })

  test(`${type} first deletion is registered only after a successful explicit null reread`, async () => {
    for (const payload of [
      { code: 0 }, { code: 0, data: undefined }, { code: 403, data: null },
      { code: 0, success: false, data: null },
      success({ id: '2110751742884233217' })
    ]) {
      const h = harness()
      if (type === 'role') {
        h.entities.user = null
        h.fixture.reviewerDeleted = true
      }
      h.overrides.set(`get:${type}`, payload)
      await assert.rejects(h.run, new RegExp(`${definition.label}删除后仍可读取`))
      assert.equal(h.fixture[`reviewer${definition.deletedKey}`], undefined)
    }
  })

  test(`${type} failed API reads or deletions propagate without registering cleanup`, async () => {
    for (const method of ['getBusiness', 'deleteBusiness', 'get']) {
      const h = harness()
      if (type === 'role') {
        h.entities.user = null
        h.fixture.reviewerDeleted = true
      }
      const error = new Error(`unit ${method}:${type} failed`)
      h.overrides.set(`${method}:${type}`, error)
      await assert.rejects(h.run, (actual) => actual === error)
      assert.equal(h.fixture[`reviewer${definition.deletedKey}`], undefined)
    }
  })
}

test('a recorded flag with a matching live identity still requires formal deletion and reread', async () => {
  const h = harness()
  h.fixture.reviewerDeleted = true
  h.fixture.reviewerRoleDeleted = true
  await h.run()
  assert.equal(h.calls.filter(({ method }) => method === 'deleteBusiness').length, 2)
  assert.deepEqual(h.entities, { user: null, role: null })
})

test('a deleted user with a failed confirmation is not silently accepted on retry', async () => {
  const h = harness()
  h.overrides.set('get:user', new Error('unit read after delete failed'))
  await assert.rejects(h.run, /unit read after delete failed/)
  assert.equal(h.entities.user, null)
  assert.equal(h.fixture.reviewerDeleted, undefined)
  h.overrides.clear()
  const before = h.calls.length
  await assert.rejects(h.run, /账号清理所有权不符/)
  assert.deepEqual(h.calls.slice(before).map(({ method, type }) => `${method}:${type}`),
    ['getBusiness:user'])
})

test('cleanup without created reviewer resources performs no API calls', async () => {
  const h = harness()
  await h.run({})
  assert.deepEqual(h.calls, [])
})
