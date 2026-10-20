import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../')
const backendRoot = process.env.CFOR_E2E_BACKEND_ROOT ||
  (fs.existsSync(path.join(workspace, 'cfor/cfor-admin'))
    ? path.join(workspace, 'cfor/cfor-admin')
    : path.join(workspace, 'backend'))
const webRoot = process.env.CFOR_E2E_WEB_ROOT ||
  (fs.existsSync(path.join(workspace, 'cfor/cfor-admin-vue3'))
    ? path.join(workspace, 'cfor/cfor-admin-vue3')
    : path.join(workspace, 'web'))

const readBackend = (file) =>
  fs.readFileSync(path.join(backendRoot, 'cfor-server/src/main/resources/db/migration', file), 'utf8')
const readWeb = (file) => fs.readFileSync(path.join(webRoot, 'src', file), 'utf8')

test('WMS 现场菜单迁移使用自动主键并挂到既有仓库入口', () => {
  const migration = readBackend('V202610201230__add_wms_board_and_operation_menus.sql')
  assert.match(migration, /FROM system_menu[\s\S]*path = 'wireSideWarehouse'/)
  assert.match(migration, /INSERT INTO system_menu\s*\(`name`, `permission`/)
  assert.doesNotMatch(migration, /SELECT 26610[0-8]\b/)
  for (const path of [
    'warehouse-overview', 'receiving-board', 'putaway-board', 'picking-board',
    'shipping-board', 'wave', 'exception', 'assembly', 'disassembly'
  ]) assert.match(migration, new RegExp(`path = '${path}'|['"]${path}['"]`))
  assert.match(migration, /JSON_ARRAY_APPEND/)
})

test('仓库现场五类看板页面都使用统一看板组件并传递仓库筛选', () => {
  for (const [folder, type, title] of [
    ['overview', 'OVERVIEW', '仓库总览'],
    ['receiving', 'RECEIVING', '收料区看板'],
    ['putaway', 'PUTAWAY', '待上架区看板'],
    ['picking', 'PICKING', '配料区看板'],
    ['shipping', 'SHIPPING', '发货区看板']
  ]) {
    const page = readWeb(`views/wms/board/${folder}/index.vue`)
    assert.match(page, new RegExp(`board-type="${type}"`))
    assert.match(page, new RegExp(`title="${title}"`))
    assert.match(page, /WarehouseBoard/)
  }
  const board = readWeb('views/wms/board/WarehouseBoard.vue')
  assert.match(board, /选择仓库/)
  assert.match(board, /warehouseId: selectedWarehouseId\.value \|\| undefined/)
  assert.match(board, /每 30 秒更新/)
  assert.match(board, /speechSynthesis/)
})

test('波次、异常和组装拆卸入口具备对应页面与业务权限', () => {
  const wave = readWeb('views/wms/operation/wave/index.vue')
  const exception = readWeb('views/wms/operation/exception/index.vue')
  const convert = readWeb('views/wms/stock/convert/receipt/index.vue')
  assert.match(wave, /wms:operation-wave:execute/)
  assert.match(wave, /wms:operation-wave:cancel/)
  assert.match(exception, /wms:operation-exception:handle/)
  assert.match(convert, /bizType/)
})
