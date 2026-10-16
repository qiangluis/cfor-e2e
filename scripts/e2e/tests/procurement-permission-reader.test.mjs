import assert from 'node:assert/strict'
import test from 'node:test'
import {
  closeProcurementReaderSession,
  createProcurementPermissionReader
} from '../fixtures/procurement-permission-reader.mjs'

const permission = 'erp:settle-method-rule:query'
const component = 'erp/settings/settleMethodRule/index'
const menus = [
  { id: '1', parentId: '0', permission: '', component: '' },
  { id: '2', parentId: '1', permission: '', component: '' },
  { id: '3', parentId: '2', permission, component: '', type: 3 },
  { id: '4', parentId: '2', permission, component, type: 2 },
  { id: '5', parentId: '4', permission: 'erp:settle-method-rule:update', component: '', type: 3 }
]

const fakeApi = (rows = menus, assignable = rows) => {
  const writes = []
  return {
    writes,
    getBusiness: async (path) => ({
      code: 0, data: path.endsWith('list-all-simple') ? assignable : rows
    }),
    postBusiness: async (path, payload) => {
      writes.push({ path, payload })
      return { code: 0, data: path.endsWith('/user/create') ? '91' : '90' }
    },
    putBusiness: async (path, payload) => {
      writes.push({ path, payload })
      return { code: 0, data: true }
    }
  }
}
const prepare = (api, options = {}) => createProcurementPermissionReader(
  api, { notes: [] }, { permission, label: 'PROC006', component, ...options }
)

test('query button siblings cannot replace the actual read-only page menu', async () => {
  const api = fakeApi()
  const reader = await prepare(api)
  const assigned = api.writes.find((call) => call.path.endsWith('/assign-role-menu'))
  assert.deepEqual(new Set(assigned.payload.menuIds), new Set(['1', '2', '3', '4']))
  assert.ok(!assigned.payload.menuIds.includes('5'))
  assert.equal(reader.credentials.username, reader.username)
})

test('legacy callers without a page component retain their query-only ancestry', async () => {
  const api = fakeApi()
  await prepare(api, { component: undefined })
  const assigned = api.writes.find((call) => call.path.endsWith('/assign-role-menu'))
  assert.deepEqual(new Set(assigned.payload.menuIds), new Set(['1', '2', '3']))
})

for (const [label, rows, assignable] of [
  ['missing page', menus.filter((row) => row.id !== '4')],
  ['duplicate page', [...menus, { ...menus[3], id: '6' }]],
  ['page requires a different permission', menus.map((row) =>
    row.id === '4' ? { ...row, permission: 'erp:settle-method-rule:update' } : row)],
  ['page excluded from tenant package', menus, menus.filter((row) => row.id !== '4')],
  ['incomplete ancestry', menus.filter((row) => row.id !== '1')],
  ['cyclic ancestry', menus.map((row) => row.id === '1' ? { ...row, parentId: '2' } : row)]
]) {
  test(`${label} blocks before creating a role or account`, async () => {
    const api = fakeApi(rows, assignable || rows)
    await assert.rejects(() => prepare(api), /BLOCKED/)
    assert.equal(api.writes.length, 0)
  })
}

test('reader cleanup closes live pages before logout and then disables the account', async () => {
  const events = []
  await closeProcurementReaderSession({
    browser: {
      flushResponses: async () => events.push('flush'),
      browser: { close: async () => events.push('close') }
    },
    readerApi: { postBusiness: async (path) => events.push(path) },
    reader: { deactivate: async () => events.push('deactivate') }
  })
  assert.deepEqual(events, ['flush', 'close', '/system/auth/logout', 'deactivate'])
})

test('reader cleanup attempts all steps and preserves every cleanup failure', async () => {
  const events = []
  const fail = (label) => async () => {
    events.push(label)
    throw new Error(label)
  }
  await assert.rejects(() => closeProcurementReaderSession({
    browser: { flushResponses: fail('flush'), browser: { close: fail('close') } },
    readerApi: { postBusiness: fail('logout') },
    reader: { deactivate: fail('deactivate') }
  }), (error) => error instanceof AggregateError && error.errors.length === 4)
  assert.deepEqual(events, ['flush', 'close', 'logout', 'deactivate'])
})
