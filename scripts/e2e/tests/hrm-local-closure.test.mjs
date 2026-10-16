import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  HRM_LOCAL_ASSERTIONS, HRM_LOCAL_REJECTIONS, assertHrmOaLocalTarget, assertClosureMarker,
  closureId, closureMarker, closureData, closureList, closureCheck, closureGap,
  finalizeLocalAssertions, createLocalClosureCleanup, closurePermissionMenus,
  resolveClosureRoute, readClosureDb, createClosureActor, createClosureEmployee,
  installHrmOaLocalApiBridge, inspectClosureSensitive, inspectClosureWorkbook,
  closureActorIdentity, findClosureRows, createClosureResource, deleteClosureResource, recoverClosureRole
} from '../fixtures/hrm-local-closure.mjs'
import { cases, runCase } from '../suites/hrm.mjs'
import { launchBrowser, login } from '../lib/browser.mjs'
import { createApiClient, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { createRunRecord, createCaseRecord } from '../lib/report.mjs'
import { redact } from '../lib/redact.mjs'

const local = {
  target: 'local', tenantId: '1', webBase: 'http://127.0.0.1:9151',
  apiBase: 'http://127.0.0.1:48083',
  db: { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard' }
}
const env = { CFOR_E2E_WRITE_FIXTURES: 'true' }
const recordOf = () => ({ checks: [], notes: [], evidence: [] })
const pageOf = (list = []) => ({ code: 0, data: { list, total: list.length } })
const marker = 'E2E-HRM001-123456789ABC'

function roleHarness ({ marker: ownedMarker = marker, suffix = 'read', id = '9', exists = false,
  changed = {}, createLost = false, deleteLost = false, deleteCommitted = true,
  userRoles = '0', exactUsers = '0', roleMenus = '0' } = {}) {
  const identity = closureActorIdentity(ownedMarker, suffix)
  const calls = []
  const role = { id, code: identity.roleCode, name: identity.nickname,
    remark: ownedMarker, type: 2, dataScope: 5, ...changed }
  let deleted = false
  const api = {
    getBusiness: async (url) => {
      calls.push(['GET', url])
      if (url.startsWith('/system/menu/')) return { code: 0, data: [
        { id: 7, parentId: 0, status: 0, permission: 'hrm:employee:query' }
      ] }
      if (url.startsWith('/system/user/page')) return pageOf()
      if (url.startsWith('/system/role/page')) return pageOf(exists && !deleted ? [role] : [])
      if (url === `/system/role/get?id=${id}`) return { code: 0, data: exists && !deleted ? role : null }
      throw new Error(`Unexpected unit GET ${url}`)
    },
    postBusiness: async (url) => {
      calls.push(['POST', url])
      if (url === '/system/role/create') {
        exists = true
        if (createLost) throw new Error('create response timeout')
        return { code: 0, data: id }
      }
      if (url === '/system/permission/assign-role-menu') throw new Error('grant timeout')
      throw new Error(`Unexpected unit POST ${url}`)
    },
    deleteBusiness: async (url) => {
      calls.push(['DELETE', url])
      assert.equal(url, `/system/role/delete?id=${id}`)
      if (deleteCommitted) deleted = true
      if (deleteLost) throw new Error('delete response timeout')
      return { code: 0, data: true }
    }
  }
  const read = async (sql) => {
    assert.match(sql, new RegExp(`tenant_id=1 AND id=${id}`))
    assert.doesNotMatch(sql, /\b(?:DELETE|UPDATE|INSERT)\b/i)
    return { available: true, rows: [
      ...(exists ? [['role', id, identity.roleCode, identity.nickname, ownedMarker, '2', deleted ? '1' : '0', '5']] : []),
      ['user-role', userRoles], ['role-menu', deleted ? '0' : roleMenus], ['exact-user', exactUsers]
    ] }
  }
  return { api, read, calls, identity, id }
}

test('HRM original assertion order is stable and empty evidence remains GAP', () => {
  assert.deepEqual(HRM_LOCAL_ASSERTIONS, [
    '员工与 system 用户一对一映射', '离职禁用访问', '敏感字段加密脱敏', '导出权限和审计'
  ])
  const record = recordOf()
  const result = finalizeLocalAssertions(record, HRM_LOCAL_ASSERTIONS, {})
  assert.equal(result.partial, true)
  assert.equal(result.acceptanceComplete, false)
  assert.deepEqual(result.remainingAssertions, HRM_LOCAL_ASSERTIONS)
  for (const assertion of HRM_LOCAL_ASSERTIONS) assert.ok(result.note.includes(assertion))
  assert.doesNotMatch(result.note, /步骤尚未实现/)
})

test('HRM exclusive suite dispatches only HRM-001 and preserves partial evidence', async () => {
  assert.deepEqual(cases, ['HRM-001'])
  const result = { partial: true, acceptanceComplete: false }
  assert.equal(await runCase({ caseId: 'HRM-001' }, {
    runHrmLocalClosure: async (context) => {
      assert.equal(context.caseId, 'HRM-001')
      return result
    }
  }), result)
  await assert.rejects(runCase({ caseId: 'OA-001' }), /Unsupported/)
})

test('write guard rejects wrong tenant, target, host, port, database and opt-in', () => {
  assert.doesNotThrow(() => assertHrmOaLocalTarget(local, env))
  for (const settings of [
    { ...local, target: 'online' }, { ...local, tenantId: '2' },
    { ...local, apiBase: 'http://127.0.0.1:48080' },
    { ...local, webBase: 'http://example.test:9151' },
    { ...local, webBase: 'http://127.0.0.1:9151/admin' },
    { ...local, db: { ...local.db, name: 'cfor_admin_saas_standard' } },
    { ...local, db: { ...local.db, host: '192.168.110.252' } }
  ]) assert.throws(() => assertHrmOaLocalTarget(settings, env), /BLOCKED/)
  assert.throws(() => assertHrmOaLocalTarget(local, {}), /BLOCKED/)
})

test('owned markers and exact numeric IDs reject SQL injection and lossy JS numbers', () => {
  for (const domain of ['HRM001', 'OA001']) {
    const marker = closureMarker(domain)
    assert.doesNotThrow(() => assertClosureMarker(marker, domain))
  }
  for (const value of ['E2E-HRM001-bad', "E2E-HRM001-123456789ABC';", 'shared']) {
    assert.throws(() => assertClosureMarker(value, 'HRM001'), /BLOCKED/)
  }
  assert.equal(closureId('2109682344865423362'), '2109682344865423362')
  for (const value of [0, -1, 1.1, 2 ** 54, '1 OR 1=1', '', null]) {
    assert.throws(() => closureId(value))
  }
})

test('HTTP success without formal business payload or bounded rows cannot prove facts', () => {
  assert.throws(() => closureData({ status: 200 }))
  assert.throws(() => closureData({ code: 500, msg: '服务器错误' }))
  assert.throws(() => closureList({ code: 0, data: {} }))
  assert.throws(() => closureList({ code: 0, data: { list: [], total: -1 } }))
  assert.throws(() => closureList({ code: 0, data: Array(101).fill({}) }))
  assert.deepEqual(closureList({ code: 0, data: { list: [{ id: 1 }], total: 1 } }), [{ id: 1 }])
  assert.equal(matchesExpectedBusinessRejection({ code: 0 }, HRM_LOCAL_REJECTIONS.duplicate), false)
  assert.equal(matchesExpectedBusinessRejection({ code: 2041100002, msg: '别的错误' },
    HRM_LOCAL_REJECTIONS.duplicate), false)
  assert.equal(matchesExpectedBusinessRejection({ code: 403, msg: '没有该操作权限' },
    HRM_LOCAL_REJECTIONS.forbidden), true)
})

test('assertions require unique exact checks; gaps and cleanup failures prevent completion', () => {
  const record = recordOf()
  closureCheck(record, 'exact', true, 'formal readback')
  assert.equal(finalizeLocalAssertions(record, ['a'], { 0: ['exact'] }).acceptanceComplete, true)
  closureGap(record, 0, 'policy not confirmed')
  assert.equal(finalizeLocalAssertions(record, ['a'], { 0: ['exact'] }).partial, true)
  delete record.localAssertionGaps
  record.checks.push({ name: 'exact', passed: true })
  assert.equal(finalizeLocalAssertions(record, ['a'], { 0: ['exact'] }).catalogComplete, false)
  record.checks.pop()
  record.checks.push({ name: 'cleanup', passed: false })
  assert.equal(finalizeLocalAssertions(record, ['a'], { 0: ['exact'] }).acceptanceComplete, false)
  assert.throws(() => closureCheck(record, 'truthy is not evidence', 200))
})

test('one assertion retains independent file, audit and policy gaps without duplication', () => {
  const record = recordOf()
  closureGap(record, 3, 'missing Content-Type')
  closureGap(record, 3, 'audit disabled in this environment')
  closureGap(record, 3, 'missing Content-Type')
  assert.deepEqual(record.localAssertionGapReasons[3],
    ['missing Content-Type', 'audit disabled in this environment'])
  const result = finalizeLocalAssertions(record, HRM_LOCAL_ASSERTIONS, {})
  assert.match(result.catalogAssertions[3].details, /missing Content-Type/)
  assert.match(result.catalogAssertions[3].details, /audit disabled/)
  assert.equal(result.catalogAssertions[3].status, 'GAP')
})

test('cleanup retries only failed entries and retains the first failure as nonpassing evidence', async () => {
  const record = recordOf()
  const cleanup = createLocalClosureCleanup(record)
  const calls = []
  cleanup.track('role', '1', async () => { calls.push('role') })
  let failed = false
  cleanup.track('user', '2', async () => {
    calls.push('user')
    if (!failed) { failed = true; throw new Error('cleanup timeout') }
  })
  cleanup.track('leave', '3', async (_, entry) => { calls.push('leave'); entry.cleanup = 'RETAINED_AUDIT' })
  await assert.rejects(cleanup.cleanup(), AggregateError)
  assert.deepEqual(calls, ['leave', 'user', 'role'])
  assert.deepEqual(record.fixtures.map((row) => row.cleanup), ['VERIFIED', 'FAILED', 'RETAINED_AUDIT'])
  await cleanup.cleanup()
  await cleanup.cleanup()
  assert.deepEqual(calls, ['leave', 'user', 'role', 'user'])
  assert.equal(record.fixtures[1].attempts, 2)
  assert.deepEqual(record.fixtures[1].cleanupErrors, ['cleanup timeout'])
  assert.equal(finalizeLocalAssertions(record, ['a'], {}).acceptanceComplete, false)
})

test('failed children block their parents, while independent resources continue and can resume', async () => {
  const record = recordOf()
  const cleanup = createLocalClosureCleanup(record)
  const calls = []
  let fail = true
  cleanup.track('role', '1', async () => { calls.push('role') })
  cleanup.track('user', '2', async () => { calls.push('user') }, { blocks: ['1'] })
  cleanup.track('employee', '3', async () => {
    calls.push('employee')
    if (fail) throw new Error('employee timeout')
  }, { blocks: ['2'] })
  cleanup.track('unrelated', '4', async () => { calls.push('unrelated') })
  await assert.rejects(cleanup.cleanup(), AggregateError)
  assert.deepEqual(calls, ['unrelated', 'employee'])
  assert.deepEqual(record.fixtures.map((row) => row.cleanup), ['BLOCKED', 'BLOCKED', 'FAILED', 'VERIFIED'])
  fail = false
  await cleanup.cleanup()
  assert.deepEqual(calls, ['unrelated', 'employee', 'employee', 'user', 'role'])
})

test('least-privilege parent chains reject wildcard, disabled and unassignable menus', () => {
  const menus = [
    { id: 1, parentId: 0, permission: '', status: 0 },
    { id: 2, parentId: 1, permission: 'hrm:employee:query', status: 0 },
    { id: 3, parentId: 2, permission: 'hrm:employee:export', status: 0 }
  ]
  assert.deepEqual(closurePermissionMenus(menus, menus, ['hrm:employee:query']), ['2', '1'])
  assert.throws(() => closurePermissionMenus(menus, menus, ['*:*:*']), /BLOCKED/)
  assert.throws(() => closurePermissionMenus(menus, [menus[1]], ['hrm:employee:query']), /BLOCKED/)
  assert.throws(() => closurePermissionMenus(menus.map((m) => ({ ...m, status: 1 })),
    menus, ['hrm:employee:query']), /BLOCKED/)
})

test('r8 grant timeout leaves a registered exact role that cleans through formal API and DB readback', async () => {
  const record = recordOf()
  const cleanup = createLocalClosureCleanup(record)
  const { api, read, calls } = roleHarness()
  await assert.rejects(createClosureActor({ adminApi: api, read, record, cleanup, marker,
    suffix: 'read', permissions: ['hrm:employee:query'] }), /grant timeout/)
  await cleanup.cleanup()
  assert.equal(record.fixtures[0].cleanup, 'VERIFIED')
  assert.deepEqual(record.fixtures[0].recovery, { kind: 'role', ...closureActorIdentity(marker, 'read'), id: '9' })
  assert.ok(calls.some(([method, url]) => method === 'DELETE' && url === '/system/role/delete?id=9'))
  assert.equal(calls.filter(([, url]) => url === '/system/permission/assign-role-menu').length, 1)
  assert.equal(calls.some(([, url]) => url === '/system/user/create'), false)
})

test('role cleanup refuses a changed ID, code, name, marker or built-in role', async () => {
  const marker = 'E2E-HRM001-123456789ABC'
  for (const changed of [
    { id: '8' }, { code: 'shared' }, { name: 'shared' }, { remark: 'shared' }, { type: 1 }, { dataScope: 1 }
  ]) {
    const record = recordOf()
    const cleanup = createLocalClosureCleanup(record)
    const { api, read, calls } = roleHarness({ changed })
    await assert.rejects(createClosureActor({ adminApi: api, read, record, cleanup, marker,
      suffix: 'read', permissions: ['hrm:employee:query'] }), /grant timeout/)
    await assert.rejects(cleanup.cleanup(), AggregateError)
    assert.equal(calls.some(([method]) => method === 'DELETE'), false)
  }
})

test('employee ownership mismatch prevents delete; read-only evidence cannot be unavailable', async () => {
  const record = recordOf()
  const cleanup = createLocalClosureCleanup(record)
  let deletes = 0
  const api = {
    getBusiness: async (url) => url.includes('/page') ? pageOf() : ({ code: 0, data: url.includes('/dept/')
      ? [{ id: '12', name: '人力资源部' }] : { jobNumber: 'shared', userId: '13' } }),
    postBusiness: async () => ({ code: 0, data: ['14'] }),
    deleteBusiness: async () => { deletes++ }
  }
  await createClosureEmployee({ adminApi: api, actor: { userId: '13', nickname: 'fixture' },
    record, cleanup, marker: 'E2E-OA001-123456789ABC-OTHER' })
  await assert.rejects(cleanup.cleanup(), AggregateError)
  assert.equal(deletes, 0)
  await assert.rejects(readClosureDb(record, 'probe', 'SELECT 1',
    async () => ({ available: false, rows: [] })), /BLOCKED/)
  assert.equal(resolveClosureRoute([{ path: '/hrm', children: [
    { path: 'employee', component: 'hrm/employee/index' }
  ] }], 'hrm/employee/index'), '/hrm/employee')
  assert.throws(() => resolveClosureRoute([
    { path: '/a', component: 'x' }, { path: '/b', component: 'x' }
  ], 'x'), /不唯一/)
})

test('employee department lookup is narrowed and never reads an unbounded simple directory', async () => {
  const record = recordOf()
  const cleanup = createLocalClosureCleanup(record)
  let posts = 0
  const api = {
    getBusiness: async (url) => {
      assert.equal(url, '/system/dept/list?name=%E4%BA%BA%E5%8A%9B%E8%B5%84%E6%BA%90%E9%83%A8&status=0')
      return { code: 0, data: [{ id: '12', name: '人力资源部' }, { id: '15', name: '人力资源部' }] }
    },
    postBusiness: async () => { posts++ }
  }
  await assert.rejects(createClosureEmployee({ adminApi: api, actor: { userId: '13' },
    record, cleanup, marker: 'E2E-HRM001-123456789ABC' }), /不唯一/)
  assert.equal(posts, 0)
})

test('a scope-filtered null employee is not masking and different stored bytes are not encryption', () => {
  const args = { id: '14', synthetic: 'E2E-SYNTHETIC', mobile: '19900000000' }
  assert.deepEqual(inspectClosureSensitive({ ...args, visible: null, stored: [['14', '1', '1']] }), {
    measured: true, idStoredPlaintext: true, mobileStoredPlaintext: true,
    ordinaryQueryVisible: false, ordinaryQueryMasked: null
  })
  const masked = inspectClosureSensitive({ ...args, stored: [['14', '0', '0']],
    visible: { id: '14', idNumber: 'E2E***', mobile: '199****0000' } })
  assert.equal(masked.ordinaryQueryMasked, true)
  assert.equal(masked.idStoredPlaintext, false)
  assert.equal(Object.hasOwn(masked, 'storageEncrypted'), false)
  assert.equal(inspectClosureSensitive({ ...args, stored: [],
    visible: { id: '14', idNumber: '', mobile: '' } }).ordinaryQueryMasked, false)
})

test('workbook evidence records exact ID, job number and mobile exposure without logging values', () => {
  const mobile = '19900000000'
  const evidence = inspectClosureWorkbook({
    rows: [{ '员工编号': '211', 工号: 'E2E-HRM001-ABCDEF123456', 手机号: mobile }],
    id: '211', marker: 'E2E-HRM001-ABCDEF123456', synthetic: 'E2E-PROBE', mobile
  })
  assert.equal(evidence.idExact, true)
  assert.equal(evidence.markerPresent, true)
  assert.equal(evidence.mobileColumnPresent, true)
  assert.equal(evidence.mobilePlaintextPresent, true)
  assert.deepEqual(evidence.sensitiveColumns, [])
  assert.equal(JSON.stringify(evidence).includes(mobile), false)
})

test('workbook substring, wrong columns, unsafe numbers and extra rows do not prove identity', () => {
  const args = { id: '211', marker: 'E2E-HRM001-ABCDEF123456', synthetic: 'E2E-PROBE' }
  for (const rows of [
    [{ 员工编号: '2110', 工号: args.marker }],
    [{ unrelated: '211', 工号: args.marker }],
    [{ 员工编号: 2 ** 54, 工号: args.marker }],
    [{ 员工编号: '211', 工号: args.marker }, { 员工编号: '212' }]
  ]) assert.equal(inspectClosureWorkbook({ ...args, rows }).idExact, false)
  assert.equal(inspectClosureWorkbook({ ...args,
    rows: [{ 员工编号: '211', 工号: `${args.marker}-OTHER` }] }).markerPresent, false)
  const sensitive = inspectClosureWorkbook({ ...args,
    rows: [{ 员工编号: '211', 工号: args.marker, 身份证: args.synthetic }] })
  assert.equal(sensitive.syntheticPresent, true)
  assert.deepEqual(sensitive.sensitiveColumns, ['身份证'])
})

test('LIKE resource lookups require a complete bounded page and exact client-side identity', async () => {
  const api = { getBusiness: async () => pageOf([{ id: '1', code: 'exact-extra' }, { id: '2', code: 'exact' }]) }
  assert.deepEqual(await findClosureRows(api, '/unit/page', (row) => row.code === 'exact'), [{ id: '2', code: 'exact' }])
  for (const response of [
    { code: 0, data: { list: [], total: 101 } },
    { code: 0, data: [] }, { status: 200 }, { code: 0, data: { list: [], total: null } }
  ]) await assert.rejects(findClosureRows({ getBusiness: async () => response }, '/unit/page', () => true))
})

test('existing exact role or username blocks all creates, without silently cleaning a previous run', async () => {
  const harness = roleHarness({ exists: true })
  const record = recordOf()
  await assert.rejects(createClosureActor({ adminApi: harness.api, read: harness.read, record,
    cleanup: createLocalClosureCleanup(record), marker, suffix: 'read', permissions: ['hrm:employee:query'] }), /已存在/)
  assert.equal(harness.calls.some(([method]) => method !== 'GET'), false)
  assert.deepEqual(record.resourceIntents[0].ids, ['9'])
  const get = harness.api.getBusiness
  harness.api.getBusiness = async (url) => url.startsWith('/system/user/page')
    ? pageOf([{ id: '8', username: harness.identity.username }]) : get(url)
  await assert.rejects(createClosureActor({ adminApi: harness.api, read: harness.read, record,
    cleanup: createLocalClosureCleanup(record), marker, suffix: 'read', permissions: ['hrm:employee:query'] }), /账号已存在/)
  assert.equal(harness.calls.some(([method]) => method !== 'GET'), false)
})

test('lost role creation response recovers its exact ID for cleanup but still fails the original operation', async () => {
  const record = recordOf()
  const cleanup = createLocalClosureCleanup(record)
  const { api, read, calls } = roleHarness({ createLost: true })
  await assert.rejects(createClosureActor({ adminApi: api, read, record, cleanup, marker,
    suffix: 'read', permissions: ['hrm:employee:query'] }), /create response timeout/)
  assert.equal(record.resourceIntents[0].state, 'RECOVERED_FOR_CLEANUP_ONLY')
  assert.equal(record.fixtures[0].id, '9')
  assert.equal(calls.filter(([, url]) => url === '/system/role/create').length, 1)
  assert.equal(calls.some(([, url]) => url === '/system/permission/assign-role-menu'), false)
  await cleanup.cleanup()
})

test('an unknown creation commit holds its parent instead of blindly retrying or deleting it', async () => {
  const record = recordOf()
  const cleanup = createLocalClosureCleanup(record)
  let parentDeletes = 0
  let creates = 0
  cleanup.track('parent role', '1', async () => { parentDeletes++ })
  await assert.rejects(createClosureResource({
    record, cleanup, label: 'owned user', recovery: { kind: 'user', marker }, blocks: ['1'],
    find: async () => [], owns: () => true, remove: async () => {},
    create: async () => { creates++; throw new Error('timeout') }
  }), /timeout/)
  await assert.rejects(cleanup.cleanup(), AggregateError)
  await assert.rejects(cleanup.cleanup(), AggregateError)
  assert.equal(creates, 1)
  assert.equal(parentDeletes, 0)
  assert.equal(record.resourceIntents[0].state, 'COMMIT_UNKNOWN')
})

test('creation recovery refuses another owner, multiple exact rows, and unbounded recovery reads', async () => {
  for (const found of [[{ id: '2', marker: 'other' }], [{ id: '2' }, { id: '3' }]]) {
    const record = recordOf()
    const cleanup = createLocalClosureCleanup(record)
    let reads = 0
    await assert.rejects(createClosureResource({
      record, cleanup, label: 'owned resource', recovery: { marker },
      find: async () => reads++ ? found : [], owns: (row) => row.marker === marker,
      create: async () => { throw new Error('timeout') }, remove: async () => { assert.fail('must not remove') }
    }), /timeout/)
    assert.equal(record.fixtures, undefined)
    assert.equal(record.resourceIntents[0].state, 'COMMIT_UNKNOWN')
    assert.match(record.resourceIntents[0].recoveryError, /所有权不符或不唯一/)
  }
})

test('exact recovery is preflight-only by default for the two registered residual roles', async () => {
  for (const fixture of [
    { marker: 'E2E-HRM001-03C84FC05BAD', suffix: 'read', id: '2110704854079717378' },
    { marker: 'E2E-OA001-2ECB3C3469E4', suffix: 'owner', id: '2110676521300353025', roleMenus: '12' }
  ]) {
    const { api, read, calls } = roleHarness({ ...fixture, exists: true })
    const result = await recoverClosureRole({ adminApi: api, read, marker: fixture.marker,
      suffix: fixture.suffix, roleId: fixture.id, settings: local, env })
    assert.equal(result.cleanup, 'PREFLIGHT_ONLY')
    assert.equal(result.exists, true)
    assert.equal(result.applied, false)
    assert.equal(calls.some(([method]) => method !== 'GET'), false)
  }
})

test('role recovery requires a second explicit write opt-in, exact marker, and lossless ID', async () => {
  const harness = roleHarness({ exists: true })
  const args = { adminApi: harness.api, read: harness.read, marker, suffix: 'read',
    roleId: '9', settings: local, env }
  for (const changed of [
    { apply: true }, { marker: 'shared' }, { roleId: 2 ** 54 }, { suffix: 'read OR 1=1' },
    { settings: { ...local, tenantId: '2' } }
  ]) await assert.rejects(recoverClosureRole({ ...args, ...changed }))
  assert.equal(harness.calls.length, 0)
})

test('recovery refuses active user bindings or a named account without changing authorization', async () => {
  for (const changed of [{ userRoles: '1' }, { exactUsers: '1' }]) {
    const { api, read, calls } = roleHarness({ ...changed, exists: true })
    await assert.rejects(recoverClosureRole({
      adminApi: api, read, marker, suffix: 'read', roleId: '9', apply: true,
      settings: local, env: { ...env, CFOR_HRM_OA_RECOVERY_APPLY: 'true' }
    }), /关联用户或精确命名账号/)
    assert.equal(calls.some(([method]) => method !== 'GET'), false)
  }
})

test('DELETE timeout committed is independently verified and a second recovery performs no DELETE', async () => {
  const { api, read, calls } = roleHarness({ exists: true, deleteLost: true })
  const args = { adminApi: api, read, marker, suffix: 'read', roleId: '9', apply: true,
    settings: local, env: { ...env, CFOR_HRM_OA_RECOVERY_APPLY: 'true' } }
  const first = await recoverClosureRole(args)
  assert.equal(first.cleanup, 'VERIFIED')
  assert.deepEqual(first.transportErrors, ['delete response timeout'])
  assert.match(first.cleanupRecovery, /DELETE_RESPONSE_LOST/)
  const second = await recoverClosureRole(args)
  assert.match(second.cleanup, /ALREADY_ABSENT/)
  assert.equal(calls.filter(([method]) => method === 'DELETE').length, 1)
})

test('DELETE timeout not committed remains failed and is not automatically retried', async () => {
  const record = recordOf()
  const cleanup = createLocalClosureCleanup(record)
  const { api, read, calls } = roleHarness({ deleteLost: true, deleteCommitted: false })
  await assert.rejects(createClosureActor({ adminApi: api, read, record, cleanup, marker,
    suffix: 'read', permissions: ['hrm:employee:query'] }), /grant timeout/)
  await assert.rejects(cleanup.cleanup(), AggregateError)
  assert.equal(record.fixtures[0].cleanup, 'FAILED')
  assert.equal(calls.filter(([method]) => method === 'DELETE').length, 1)
  await assert.rejects(cleanup.cleanup(), AggregateError)
  assert.equal(record.fixtures[0].attempts, 2)
  assert.equal(calls.filter(([method]) => method === 'DELETE').length, 2)
})

test('missing deletion readback is idempotent only with successful association verification', async () => {
  let deletes = 0
  let verifies = 0
  const args = { api: { deleteBusiness: async () => { deletes++ } }, path: '/unit/delete?id=1',
    get: async () => null, owns: () => { assert.fail('no object to own') }, entry: {} }
  await deleteClosureResource({ ...args, verify: async () => { verifies++ } })
  await assert.rejects(deleteClosureResource({ ...args,
    verify: async () => { throw new Error('links remain') } }), /links remain/)
  assert.equal(deletes, 0)
  assert.equal(verifies, 1)
})

test('HRM local headed formal write/readback/cleanup evidence', {
  skip: process.env.CFOR_HRM_OA_LOCAL_HEADED !== '1', timeout: 240000
}, async () => {
  const outputDir = path.join(process.env.CFOR_HRM_OA_LOCAL_OUT || '/tmp/cfor-e2e/hrm-oa-local-closure',
    `HRM-001-${Date.now()}`)
  await fs.mkdir(outputDir, { recursive: true })
  const record = createRunRecord({ selectedCases: ['HRM-001'] })
  const caseRecord = createCaseRecord({ id: 'HRM-001', suite: 'hrm-pms-oa', title: 'HRM local closure' })
  record.cases.push(caseRecord)
  let handle
  let error
  try {
    handle = await launchBrowser({ headed: true, record })
    await installHrmOaLocalApiBridge(handle.context, record)
    const api = createApiClient({ token: await login(handle.page), tenantId: '1', record })
    const result = await runCase({ caseId: 'HRM-001', api, page: handle.page, record, caseRecord, outputDir })
    assert.equal(result.partial, true)
    assert.equal(result.acceptanceComplete, false)
    assert.ok(caseRecord.checks.every((row) => row.passed))
    assert.ok(caseRecord.fixtures.every((row) => row.cleanup !== 'PENDING' && row.cleanup !== 'FAILED'))
    caseRecord.status = 'PARTIAL'
  } catch (failure) {
    error = failure
    caseRecord.status = 'FAIL'
    caseRecord.notes.push(failure.message)
  } finally {
    try { await handle?.flushResponses() } finally { await handle?.browser.close() }
    record.finishedAt = new Date().toISOString()
    await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify(redact(record), null, 2))
    console.log(`HRM real report: ${outputDir}/report.json`)
  }
  if (error) throw error
})
