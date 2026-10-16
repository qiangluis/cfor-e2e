import assert from 'node:assert/strict'
import test from 'node:test'
import { tenantListReadabilityFact } from '../fixtures/tenant-list-readability.mjs'

const metrics = () => ({
  width: 1000, rows: 1, rowHeights: [44],
  cells: Array.from({ length: 5 }, () => ({ width: 140, height: 23, whiteSpace: 'nowrap' })),
  scrollWidth: 2000, clientWidth: 1000, scrollLeft: 400
})

test('tenant readability requires nonempty real rows, readable sizes and working table scrolling', () => {
  assert.equal(tenantListReadabilityFact(metrics()), true)
  for (const change of [
    (value) => { value.rows = 0 },
    (value) => { value.rowHeights[0] = 170 },
    (value) => { value.rowHeights[0] = NaN },
    (value) => { value.cells[0].whiteSpace = 'normal' },
    (value) => { value.cells[0].height = 60 },
    (value) => { value.cells[0].width = 40 },
    (value) => { value.cells.pop() },
    (value) => { value.scrollLeft = 0 },
    (value) => { value.scrollWidth = value.clientWidth }
  ]) {
    const value = metrics()
    change(value)
    assert.equal(tenantListReadabilityFact(value), false)
  }
  assert.equal(tenantListReadabilityFact(null), false)
})
