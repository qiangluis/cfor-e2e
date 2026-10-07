import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('payment request amount column uses its existing renderer and footer slot', () => {
  const sourcePath = fileURLToPath(new URL(
    '../../../../cfor/cfor-admin-vue3/src/views/erp/purchase/request/payment/index.vue',
    import.meta.url
  ))
  if (!fs.existsSync(sourcePath)) {
    // The application checkout is optional for portable E2E unit tests.
    return
  }
  const source = fs.readFileSync(sourcePath, 'utf8')
  const amountColumn = source.slice(source.indexOf("title: '付款金额'"),
    source.indexOf("title: '已付金额'"))
  assert.match(amountColumn, /slots:\s*\{\s*footer:\s*'footer_cell'\s*\}/)
  assert.doesNotMatch(amountColumn, /defult|['"]dict['"]/)
  assert.match(source, /template #footer_cell/)
})
