import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PMS_MEMBER_PERMISSIONS,
  PMS_MEMBER_REJECTIONS,
  isExactPmsRejection,
  pmsPermissionMenuIds,
  verifyPmsMemberPermissions
} from '../fixtures/pms-member-permissions.mjs'

const root = { id: 1, parentId: 0, status: 0, permission: '' }
const menus = [root, ...PMS_MEMBER_PERMISSIONS.map((permission, index) => ({
  id: index + 2, parentId: 1, status: 0, permission
}))]

test('PMS account receives exact scoped permissions and complete enabled ancestors', () => {
  assert.deepEqual(pmsPermissionMenuIds(menus, menus), ['2', '1', '3', '4', '5', '6'])
  assert.equal(PMS_MEMBER_PERMISSIONS.some((code) => code.includes('*') || code.startsWith('system:')), false)
})

test('PMS permission plan rejects unassignable or disabled ancestors before writing', () => {
  assert.throws(() => pmsPermissionMenuIds(menus, menus.slice(1)), /不可分配/)
  assert.throws(() => pmsPermissionMenuIds([{ ...root, status: 1 }, ...menus.slice(1)], menus), /不可分配/)
  assert.throws(() => pmsPermissionMenuIds(menus.slice(0, -1), menus), /缺少启用权限/)
})

test('PMS permission plan rejects cyclic, missing and wildcard parents', () => {
  assert.throws(() => pmsPermissionMenuIds([{ ...root, parentId: 1 }, ...menus.slice(1)], menus), /不可分配/)
  assert.throws(() => pmsPermissionMenuIds([{ ...root, parentId: 99 }, ...menus.slice(1)], menus), /父链缺失/)
  assert.throws(() => pmsPermissionMenuIds([{ ...root, permission: '*:*:*' }, ...menus.slice(1)], menus), /通配权限/)
})

for (const [name, contract] of Object.entries(PMS_MEMBER_REJECTIONS)) {
  test(`PMS ${name} requires exact domain error and no leaked data`, () => {
    assert.equal(isExactPmsRejection({ code: contract.code, msg: contract.message, data: null }, contract), true)
    for (const response of [
      { code: 500, msg: contract.message },
      { code: 403, msg: '没有该操作权限' },
      { code: contract.code, msg: 'another rejection' },
      { code: contract.code, msg: contract.message, data: { id: 1 } },
      { code: contract.code, msg: contract.message, success: true }
    ]) assert.equal(isExactPmsRejection(response, contract), false)
  })
}

test('PMS member verification refuses a public or foreign project before creating accounts', async () => {
  for (const project of [
    { name: 'shared', openStatus: false },
    { name: 'E2E_PMS_001_TEST', openStatus: true }
  ]) {
    await assert.rejects(verifyPmsMemberPermissions({
      adminApi: { getBusiness: async () => ({ code: 0, data: project }) },
      projectId: '101', marker: 'E2E_PMS_001_TEST'
    }), /专属私有项目/)
  }
})
