import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  OwnedInitFixtures,
  assertOwnedInitScope,
  ownedCatalog,
  ownedInitCases
} from '../owned-init/fixtures.mjs'

const local = {
  target: 'local',
  tenantId: '1',
  tenantName: 'CFOR 标准平台',
  apiBase: 'http://127.0.0.1:48083',
  webBase: 'http://127.0.0.1:9151',
  db: { name: 'cfor_admin_standard' }
}

test('owned init scope rejects non-local, wrong tenant, database, or endpoint', () => {
  assert.doesNotThrow(() => assertOwnedInitScope(local))
  for (const change of [
    { target: 'production' },
    { tenantId: '2' },
    { tenantName: 'other' },
    { db: { name: 'cfor_admin_saas' } },
    { apiBase: 'http://127.0.0.1:48084' },
    { webBase: 'https://example.invalid:9151' },
    { apiBase: 'http://user:secret@127.0.0.1:48083' }
  ]) assert.throws(() => assertOwnedInitScope({ ...local, ...change }), /BLOCKED:/)
})

test('owned init exposes reversible fixtures and a tenant-scoped invitation accept contract', () => {
  assert.deepEqual(ownedInitCases, [
    'PB004-001', 'PB005-001', 'PB007-001', 'PB008-001', 'PB008-002'
  ])
  const source = fs.readFileSync(new URL('../owned-init/fixtures.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /system_enterprise_organization|system_config/)
  assert.doesNotMatch(source, /resetUserPassword/)
  assert.match(source, /system\/user\/update-password/)
  assert.doesNotMatch(source, /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE)\b/i)
  assert.doesNotMatch(source, /\bDELETE\s+FROM\s+(?:system_|tenant_)/i)
  assert.match(source, /const publicApi = createApiClient\(\{ tenantId: '1' \}\)/)
  assert.match(source, /username='\$\{invitedUsername\}'/)
  assert.match(source, /noExisting\[0\]\?\.\[0\] === '0'/)
  assert.match(source, /['"]\/system\/tenant-user-invitation\/accept['"]/)
  assert.match(source, /token: invitation\.invitationToken/)
  assert.match(source, /password: '12345678'/)
  assert.match(source, /const acceptedPassword = `R!\$\{randomBytes\(7\)\.toString\('hex'\)\}`/)
  assert.match(source, /context\.record\.api\.push\(createEvidence\)/)
  assert.doesNotMatch(source, /createEvidence[\s\S]{0,400}invitationToken/)
  assert.match(source, /settleInvitation\(invitationId, invitedUsername\)/)
})

test('invitation member registration requires matching owned tenant, invitation, and account', async () => {
  const record = { checks: [] }
  let rows = [['1', 'E2EOWNtest', 'ACCEPTED', '123']]
  let user = { id: '123', username: 'E2EOWNtestMember', nickname: 'E2EOWNtest' }
  const fixtures = new OwnedInitFixtures({
    getBusiness: async () => ({ code: 0, data: user })
  }, record, async () => ({ available: true, rows }))
  fixtures.tag = 'E2EOWNtest'
  for (const invalid of [
    ['2', 'E2EOWNtest', 'ACCEPTED', '123'],
    ['1', 'other', 'ACCEPTED', '123'],
    ['1', 'E2EOWNtest', 'PENDING', '123'],
    ['1', 'E2EOWNtest', 'ACCEPTED', '124']
  ]) {
    rows = [invalid]
    await assert.rejects(fixtures.trackInvitationUser('456', 'E2EOWNtestMember', '123'), /ownership mismatch/)
    assert.equal(fixtures.resources.length, 0)
  }
  rows = [['1', 'E2EOWNtest', 'ACCEPTED', '123']]
  user = { ...user, username: 'realUser' }
  await assert.rejects(fixtures.trackInvitationUser('456', 'E2EOWNtestMember', '123'), /ownership mismatch/)
  assert.equal(fixtures.resources.length, 0)
  user = { ...user, username: 'E2EOWNtestMember' }
  await fixtures.trackInvitationUser('456', 'E2EOWNtestMember', '123')
  await fixtures.trackInvitationUser('456', 'E2EOWNtestMember', '123')
  assert.equal(fixtures.resources.length, 1)
  assert.equal(fixtures.resources[0].invitationId, '456')
  assert.equal(record.fixtures[0].tenantId, '1')
})

test('pending owned invitation cleanup uses revoke while ownership mismatch makes no write', async () => {
  const calls = []
  let rows = [['2', 'E2EOWNtest', 'PENDING', 'NULL']]
  const fixtures = new OwnedInitFixtures({
    postBusiness: async (path) => {
      calls.push(path)
      rows = [['CANCELLED']]
      return { code: 0, data: true }
    }
  }, { checks: [] }, async () => ({ available: true, rows }))
  fixtures.tag = 'E2EOWNtest'
  await assert.rejects(fixtures.settleInvitation('456', 'E2EOWNtestMember'), /ownership mismatch/)
  assert.deepEqual(calls, [])
  rows = [['1', 'E2EOWNtest', 'PENDING', 'NULL']]
  await fixtures.settleInvitation('456', 'E2EOWNtestMember')
  assert.deepEqual(calls, ['/system/tenant-user-invitation/revoke?id=456'])
})

test('mobile-bound user omits username and records persisted identity for safe cleanup', async () => {
  let createBody
  const record = { checks: [] }
  const fixtures = new OwnedInitFixtures({
    postBusiness: async (_path, body) => {
      createBody = { ...body }
      return { code: 0, data: '123' }
    },
    getBusiness: async () => ({ code: 0, data: { username: createBody.mobile } })
  }, record)
  const user = await fixtures.mobileBoundUser('2', [], [])
  assert.equal(Object.hasOwn(createBody, 'username'), false)
  assert.equal(user.username, createBody.mobile)
  assert.equal(fixtures.resources[0].body.username, createBody.mobile)
  assert.equal(record.fixtures[0].id, '123')
  assert.equal(record.fixtures[0].marker, createBody.mobile)
})

test('owned fixture cleanup deletes user before referenced post and role, and propagates failures', async () => {
  const calls = []
  const rows = new Map([
    ['user/3', { id: '3', username: 'OWN', remark: 'TAG' }],
    ['post/2', { id: '2', code: 'POST', remark: 'TAG' }],
    ['role/1', { id: '1', code: 'ROLE', remark: 'TAG' }]
  ])
  const api = {
    getBusiness: async (path) => {
      const key = path.match(/\/system\/(user|post|role)\/get\?id=(\d+)/)
      const value = key ? rows.get(`${key[1]}/${key[2]}`) ?? null : null
      calls.push(['get', path])
      return { code: 0, data: value }
    },
    deleteBusiness: async (path) => {
      calls.push(['delete', path])
      const match = path.match(/\/system\/(user|post|role)\/delete\?id=(\d+)/)
      rows.delete(`${match[1]}/${match[2]}`)
      return { code: 0, data: true }
    }
  }
  const record = { checks: [] }
  const fixtures = new OwnedInitFixtures(api, record, async (sql) => ({
    available: true,
    rows: [...sql.matchAll(/SELECT '(system_\w+)'/g)].map((match) => [match[1], '0'])
  }))
  fixtures.tag = 'TAG'
  fixtures.resources = [
    { kind: 'role', id: '1', body: { code: 'ROLE' } },
    { kind: 'post', id: '2', body: { code: 'POST' } },
    { kind: 'user', id: '3', body: { username: 'OWN' } }
  ]
  await fixtures.cleanup()
  assert.deepEqual(calls.filter(([kind]) => kind === 'delete').map(([, path]) => path), [
    '/system/user/delete?id=3',
    '/system/role/delete?id=1',
    '/system/post/delete?id=2'
  ])
  assert.ok(record.checks.every((check) => check.passed))
})

test('owned fixture cleanup rejects remaining active relationship rows', async () => {
  const record = { checks: [] }
  const api = { getBusiness: async () => ({ code: 0, data: null }) }
  const fixtures = new OwnedInitFixtures(api, record, async () => ({
    available: true,
    rows: [['system_post', '0'], ['system_user_post', '1']]
  }))
  fixtures.resources = [{ kind: 'post', id: '2', body: { code: 'POST' } }]
  await assert.rejects(fixtures.cleanup(), /BLOCKED: owned cleanup failed/)
  assert.ok(record.checks.some((check) => check.passed === false))
})

test('owned catalog evidence preserves all assertions and marks unverified work as GAP', () => {
  const record = { checks: [{ passed: true }] }
  ownedCatalog(record, 'PB008-002', [0, 1])
  assert.equal(record.catalogAssertions.length, 4)
  assert.equal(record.catalogAssertions[0].status, 'VERIFIED')
  assert.equal(record.catalogAssertions[1].status, 'VERIFIED')
  assert.equal(record.readyCandidate, false)
  assert.equal(record.remainingAssertions.length, 2)
})
