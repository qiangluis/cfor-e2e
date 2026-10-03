import test from 'node:test'
import assert from 'node:assert/strict'
import { createPurchaseReader } from '../fixtures/purchase-reader.mjs'

const menus = [
  { id: 10, parentId: 1, permission: 'erp:purchase-order-request:query' },
  { id: 1, parentId: 0, permission: '' }
]

test('missing package menus block account creation before any write', async () => {
  const calls = []
  const api = {
    async getBusiness (path) {
      calls.push(path)
      return { data: path === '/system/menu/list' ? menus : [menus[1]] }
    },
    async postBusiness () { throw new Error('must not create a role or user') }
  }
  await assert.rejects(createPurchaseReader(api, {}), /BLOCKED:.*10/)
  assert.deepEqual(calls, ['/system/menu/list', '/system/menu/list-all-simple'])
})

test('failed user-role assignment deactivates the fixture user and removes its role', async () => {
  const calls = []
  const api = {
    async getBusiness () { return { data: menus } },
    async postBusiness (path) {
      calls.push(path)
      if (path === '/system/role/create') return { data: '101' }
      if (path === '/system/user/create') return { data: '201' }
      if (path === '/system/permission/assign-user-role') throw new Error('assignment rejected')
      return { data: true }
    },
    async putBusiness (path, body) { calls.push([path, body]) },
    async deleteBusiness (path) { calls.push(path) }
  }
  const record = { notes: [] }
  await assert.rejects(createPurchaseReader(api, record), /assignment rejected/)
  assert.deepEqual(calls.slice(-2), [
    ['/system/user/update-status', { id: '201', status: 1 }],
    '/system/role/delete?id=101'
  ])
  assert.match(record.notes[0], /清理本轮角色 101/)
})

test('cleanup errors remain visible and do not replace the original fixture failure', async () => {
  const api = {
    async getBusiness () { return { data: menus } },
    async postBusiness (path) {
      if (path === '/system/role/create') return { data: '101' }
      throw new Error('menu assignment rejected')
    },
    async deleteBusiness () { throw new Error('cleanup rejected') }
  }
  const record = { notes: [] }
  await assert.rejects(createPurchaseReader(api, record), /menu assignment rejected/)
  assert.match(record.notes[0], /清理未完成：cleanup rejected/)
})
