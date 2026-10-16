import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CRM_ACTOR_CASES,
  CRM_ACTOR_PERMISSIONS,
  crmActorMenuIds,
  crmActorRequirements,
  withCrmAcceptanceActor,
  closeCrmAcceptanceRun
} from '../fixtures/crm-acceptance-actor.mjs'

const menus = (selectedCases = CRM_ACTOR_CASES) => [
  { id: '100', parentId: '0', status: 0, permission: '', path: 'business' },
  { id: '200', parentId: '0', status: 0, permission: 'system:settings:query', path: 'settings' },
  { id: '201', parentId: '200', status: 0, permission: '', path: 'crm' },
  ...CRM_ACTOR_PERMISSIONS.map((permission, index) => ({
    id: String(101 + index), parentId: '100', status: 0, permission
  })),
  ...crmActorRequirements(selectedCases).pageComponents.map((component, index) => ({
    id: String(300 + index), parentId: '201', status: 0, permission: '',
    path: `page-${index}`, component
  }))
]
const success = (data) => ({ code: 0, data })
const local = {
  target: 'local', tenantId: '1', apiBase: 'http://127.0.0.1:48083',
  webBase: 'http://127.0.0.1:9151', tenantName: 'CFOR 标准平台', headless: true
}

function harness({
  selectedCases = CRM_ACTOR_CASES,
  permissionPatch = {},
  roleScope = 5,
  tree: suppliedTree,
  assignableIds: suppliedAssignableIds
} = {}) {
  const calls = []
  const tree = suppliedTree || menus(selectedCases)
  const assignableIds = suppliedAssignableIds || tree.map((row) => row.id)
  const requirements = crmActorRequirements(selectedCases)
  let roleCode
  let username
  let status = 0
  const api = {
    getBusiness: async (path) => {
      calls.push(['GET', path])
      if (path === '/system/menu/list') return success(tree)
      if (path === '/system/menu/list-all-simple') {
        return success(assignableIds.map((id) => ({ id })))
      }
      if (path.startsWith('/system/role/get')) return success({ id: '20', code: roleCode, dataScope: roleScope })
      if (path.startsWith('/system/user/get')) return success({ id: '30', username, status })
      throw new Error(`unexpected ${path}`)
    },
    postBusiness: async (path, body) => {
      calls.push(['POST', path, structuredClone(body)])
      if (path === '/system/role/create') { roleCode = body.code; return success('20') }
      if (path === '/system/user/create') { username = body.username; return success('30') }
      return success(true)
    },
    putBusiness: async (path, body) => { calls.push(['PUT', path, body]); status = body.status; return success(true) },
    deleteBusiness: async (path) => { calls.push(['DELETE', path]); return success(true) }
  }
  const actor = {
    getBusiness: async () => success({
      user: { id: '30', username }, roles: [roleCode],
      permissions: [...requirements.permissions, ...requirements.navPermissions], ...permissionPatch
    }),
    postBusiness: async (path) => { calls.push(['ACTOR', path]); return success(true) }
  }
  const dependencies = {
    config: local,
    launchBrowser: async () => {
      calls.push(['BROWSER'])
      return {
        page: { actor: true }, context: {},
        flushResponses: async () => calls.push(['FLUSH']),
        browser: { close: async () => calls.push(['CLOSE']) }
      }
    },
    loginWithCredentials: async (_page, credentials) => {
      assert.equal(credentials.username, username)
      assert.ok(credentials.password.length <= 16)
      calls.push(['LOGIN'])
      return { token: 'private-actor-token', tenantId: '1' }
    },
    createApiClient: () => actor
  }
  return { api, actor, dependencies, calls }
}
const context = (record, caseId, caseRecord = { checks: [], notes: [] }) =>
  ({ record, caseId, caseRecord })

test('minimal menu closure preserves requested permissions and enabled ancestry', () => {
  const selectedCases = ['CRM-BASE-001']
  const tree = menus(selectedCases)
  const requiredPermission = crmActorRequirements(selectedCases).permissions[0]
  for (const mutation of [
    (rows) => { rows.find((row) => row.permission === requiredPermission).status = 1 },
    (rows) => { rows.find((row) => row.component === 'crm/business/status/index').parentId = '999' },
    (rows) => { rows.find((row) => row.id === '201').permission = '*:*:*' },
    (rows) => { rows.find((row) => row.component === 'crm/business/status/index').status = 1 }
  ]) {
    const rows = menus(selectedCases)
    mutation(rows)
    assert.throws(() => crmActorMenuIds(rows, rows.map((row) => row.id)), /BLOCKED/)
  }
  const missingPackagePermission = tree.find((row) => row.permission === requiredPermission)
  assert.throws(() => crmActorMenuIds(tree,
    tree.filter((row) => row.id !== missingPackagePermission.id).map((row) => row.id)), /BLOCKED/)
  const ids = crmActorMenuIds(tree, tree.map((row) => row.id), selectedCases)
  const requirements = crmActorRequirements(selectedCases)
  const grantedPermissions = tree.filter((row) => ids.includes(String(row.id)) && row.permission)
    .map((row) => row.permission)
  assert.deepEqual(new Set(grantedPermissions),
    new Set([...requirements.permissions, ...requirements.navPermissions]))
  assert.ok(ids.includes('200') && ids.includes('201') &&
    ids.includes(tree.find((row) => row.component === requirements.pageComponents[0]).id))
})

test('CRM-BASE-001 grants only the business-status read permission needed for its real page evidence', () => {
  const profile = crmActorRequirements(['CRM-BASE-001'])
  assert.ok(profile.permissions.includes('crm:business-status:query'))
  for (const permission of [
    'crm:business-status:create', 'crm:business-status:update', 'crm:business-status:delete'
  ]) assert.ok(!profile.permissions.includes(permission))
})

test('each CRM acceptance case receives only its own profile and current formal page', () => {
  for (const caseId of CRM_ACTOR_CASES) {
    const requirements = crmActorRequirements([caseId])
    const tree = menus([caseId])
    const ids = crmActorMenuIds(tree, tree.map((row) => row.id), [caseId])
    const grantedPermissions = tree.filter((row) => ids.includes(String(row.id)) && row.permission)
      .map((row) => row.permission)
    assert.deepEqual(new Set(grantedPermissions),
      new Set([...requirements.permissions, ...requirements.navPermissions]), caseId)
    for (const component of requirements.pageComponents) {
      assert.ok(ids.includes(tree.find((row) => row.component === component).id), `${caseId} page`)
    }
  }
})

test('formal pages reject legacy ancestry while permission buttons remain exact', () => {
  const tree = menus(['CRM-BASE-001'])
  tree.find((row) => row.id === '201').path = '/__legacy__/crm'
  assert.throws(() => crmActorMenuIds(tree, tree.map((row) => row.id), ['CRM-BASE-001']), /BLOCKED/)
  const cleanTree = menus(['CRM-BASE-001'])
  const cleanIds = crmActorMenuIds(cleanTree, cleanTree.map((row) => row.id), ['CRM-BASE-001'])
  assert.ok(cleanIds.includes(
    cleanTree.find((row) => row.permission === 'crm:business-status:query').id))
})

test('same-run CRM cases share one actor login and clean it after the final case', async () => {
  const selectedCases = ['CRM-BASE-001', 'CRM-BASE-002', 'CRM-BASE-003', 'CRM-BASE-005']
  const h = harness({ selectedCases })
  const record = { selectedCases }
  const caseRecords = selectedCases.map((caseId) => context(record, caseId))
  const actorIds = []
  const run = async (actorContext, actorApi, id) => {
    assert.equal(actorContext.page.actor, true)
    assert.equal(actorApi, h.actor)
    assert.equal(id, '30')
    actorIds.push(id)
    return { partial: true }
  }
  for (const [index, actorContext] of caseRecords.entries()) {
    await withCrmAcceptanceActor(actorContext, h.api, run, h.dependencies)
    if (index < caseRecords.length - 1) {
      assert.equal(h.calls.filter(([kind]) => kind === 'CLOSE').length, 0)
    }
  }
  assert.equal(h.calls.filter(([kind]) => kind === 'LOGIN').length, 1)
  assert.equal(h.calls.filter(([kind]) => kind === 'CLOSE').length, 1)
  assert.deepEqual(actorIds, ['30', '30', '30', '30'])
  assert.ok(h.calls.some(([kind, path]) => kind === 'ACTOR' && path === '/system/auth/logout'))
  assert.ok(h.calls.some(([kind, path, body]) => kind === 'PUT' &&
    path === '/system/user/update-status' && body.id === '30' && body.status === 1))
  assert.ok(h.calls.some(([kind, path, body]) => kind === 'POST' &&
    path === '/system/permission/assign-role-data-scope' && body.dataScope === 5))
  assert.deepEqual(caseRecords.map(({ caseRecord }) => caseRecord.accounts[0].reused),
    [false, true, true, true])
  assert.ok(caseRecords.every(({ caseRecord }) => caseRecord.accounts[0].userId === '30'))
  assert.doesNotMatch(JSON.stringify(caseRecords), /private-actor-token|"password"/)
  assert.ok(!h.calls.some(([, path]) => /customer-limit-config|tenant-package/.test(path || '')))
})

test('failures close the owned actor immediately and do not keep a reusable bad session', async () => {
  const selectedCases = ['CRM-BASE-001', 'CRM-BASE-003']
  const h = harness({ selectedCases })
  const record = { selectedCases }
  await assert.rejects(withCrmAcceptanceActor(context(record, 'CRM-BASE-001'), h.api,
    async () => { throw new Error('business failed private-actor-token') }, h.dependencies),
  /business failed \[REDACTED\]/)
  await withCrmAcceptanceActor(context(record, 'CRM-BASE-003'), h.api,
    async () => ({}), h.dependencies)
  assert.equal(h.calls.filter(([kind]) => kind === 'LOGIN').length, 2)
  assert.equal(h.calls.filter(([kind]) => kind === 'CLOSE').length, 2)
})

test('unexpected permissions or non-SELF scope fail closed before business fixtures', async () => {
  for (const option of [
    { permissionPatch: { permissions: [...CRM_ACTOR_PERMISSIONS, '*:*:*'] } },
    { permissionPatch: { roles: ['super_admin'] } },
    { roleScope: 1 }
  ]) {
    const h = harness({ ...option, selectedCases: ['CRM-BASE-001'] })
    let ran = false
    await assert.rejects(withCrmAcceptanceActor(context({}, 'CRM-BASE-001'), h.api,
      async () => { ran = true }, h.dependencies), /CRM 专属/)
    assert.equal(ran, false)
    if (option.roleScope !== 1) {
      assert.ok(h.calls.some(([kind, path]) => kind === 'PUT' && path === '/system/user/update-status'))
    } else {
      assert.ok(h.calls.some(([kind, path]) => kind === 'DELETE' && path === '/system/role/delete?id=20'))
    }
  }
  const requirements = crmActorRequirements(['CRM-BASE-001'])
  const h = harness({ selectedCases: ['CRM-BASE-001'], permissionPatch: {
    permissions: ['', ...requirements.permissions, 'system:settings:query']
  } })
  await withCrmAcceptanceActor(context({}, 'CRM-BASE-001'), h.api,
    async () => ({}), h.dependencies)
  assert.equal(h.calls.filter(([kind]) => kind === 'CLOSE').length, 1)
})

test('missing permission, package page, parent chain, or disabled node leaves BLOCKED evidence', async () => {
  const caseId = 'CRM-BASE-002'
  const scenarios = [
    (tree) => {
      const row = tree.find((item) => item.permission === 'crm:customer:create')
      return { tree, assignableIds: tree.filter((item) => item.id !== row.id).map((item) => item.id) }
    },
    (tree) => {
      const row = tree.find((item) => item.component === 'crm/jixu/privatePool/index?archive=all')
      return { tree, assignableIds: tree.filter((item) => item.id !== row.id).map((item) => item.id) }
    },
    (tree) => {
      const parent = tree.find((item) => item.id === '201')
      return {
        tree: tree.filter((item) => item.id !== parent.id),
        assignableIds: tree.filter((item) => item.id !== parent.id).map((item) => item.id)
      }
    },
    (tree) => {
      tree.find((item) => item.component === 'crm/jixu/privatePool/index?archive=all').status = 1
      return { tree, assignableIds: tree.map((item) => item.id) }
    }
  ]
  for (const configure of scenarios) {
    const tree = menus([caseId])
    const scenario = configure(tree)
    const h = harness({ selectedCases: [caseId], ...scenario })
    const record = { selectedCases: [caseId] }
    const caseRecord = { checks: [], notes: [] }
    await assert.rejects(withCrmAcceptanceActor(
      context(record, caseId, caseRecord), h.api, async () => {}, h.dependencies), /BLOCKED/)
    assert.match(caseRecord.notes.join('\n'), /BLOCKED/)
    assert.equal(h.calls.some(([kind, path]) => kind === 'POST' && path === '/system/role/create'), false)
  }
})

test('production and unsupported cases never create an acceptance actor', async () => {
  const h = harness()
  await assert.rejects(withCrmAcceptanceActor(context({}, 'CRM-BASE-004'), h.api,
    async () => {}, h.dependencies), /BLOCKED/)
  await assert.rejects(withCrmAcceptanceActor(context({}, 'CRM-BASE-001'), h.api,
    async () => {}, { ...h.dependencies, config: { ...local, target: 'production' } }), /BLOCKED/)
  assert.equal(h.calls.length, 0)
})

test('run teardown cleans a pooled actor when the following selected case never runs', async () => {
  const h = harness({ selectedCases: ['CRM-BASE-001', 'CRM-BASE-003'] })
  const record = { selectedCases: ['CRM-BASE-001', 'CRM-BASE-003'], cases: [] }
  const first = context(record, 'CRM-BASE-001')
  await withCrmAcceptanceActor(first, h.api, async () => ({}), h.dependencies)
  const finalized = structuredClone(first.caseRecord)
  finalized.id = first.caseId
  record.cases.push(finalized)
  await closeCrmAcceptanceRun(record)
  await closeCrmAcceptanceRun(record)
  assert.equal(h.calls.filter(([kind]) => kind === 'CLOSE').length, 1)
  assert.equal(finalized.checks.at(-1).passed, true)
  assert.match(finalized.checks.at(-1).name, /退出并停用/)
})
