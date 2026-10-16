import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertProjectBusinessMenus,
  PROJECT_BUSINESS_MENU_NAMES
} from '../fixtures/project-menu.mjs'

const rows = () => Object.entries(PROJECT_BUSINESS_MENU_NAMES).flatMap(([id, names]) =>
  names.map((name, index) => [id, String(index + 1), name, `entry-${index}`, '1', 'project-management/report/index'])
)

test('project menus require every documented business entry in order', () => {
  assert.doesNotThrow(() => assertProjectBusinessMenus(rows()))
  assert.throws(() => assertProjectBusinessMenus(rows().slice(1)), /项目业务子菜单不完整/)
  const reversed = rows()
  ;[reversed[0], reversed[1]] = [reversed[1], reversed[0]]
  assert.throws(() => assertProjectBusinessMenus(reversed), /项目业务子菜单不完整/)
})

test('project menus reject visible duplicates and missing page components', () => {
  const duplicate = rows()
  duplicate[1][3] = duplicate[0][3]
  assert.throws(() => assertProjectBusinessMenus(duplicate), /地址重复/)
  const missing = rows()
  missing[0][5] = 'NULL'
  assert.throws(() => assertProjectBusinessMenus(missing), /没有页面组件/)
})
