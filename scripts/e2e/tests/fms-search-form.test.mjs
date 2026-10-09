import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareOpeningBatchFilter } from '../fmshelper/search-form.mjs'

function fixture ({ count = 1, visible = true } = {}) {
  const events = []
  const field = {
    waitFor: async () => events.push('visible'),
    evaluate: async () => {
      events.push('bounds')
      return visible
    }
  }
  const collapsed = {
    count: async () => count,
    locator: (selector) => {
      assert.equal(selector, '.search-collapse__toggle')
      return { click: async () => events.push('expand') }
    }
  }
  const page = {
    getByPlaceholder: (value, options) => {
      assert.equal(value, '期初导入批次号')
      assert.deepEqual(options, { exact: true })
      return field
    },
    locator: (selector) => {
      assert.equal(selector, '.search-collapse.is-collapsed')
      return { filter: ({ has }) => {
        assert.equal(has, field)
        return collapsed
      } }
    }
  }
  return { page, field, events }
}

test('opening filter expands its containing search form before checking visibility', async () => {
  const f = fixture()
  assert.equal(await prepareOpeningBatchFilter(f.page), f.field)
  assert.deepEqual(f.events, ['expand', 'visible', 'bounds'])
})

test('already expanded opening filter leaves the form state unchanged', async () => {
  const f = fixture({ count: 0 })
  await prepareOpeningBatchFilter(f.page)
  assert.deepEqual(f.events, ['visible', 'bounds'])
})

test('clipped opening filter cannot proceed to fill', async () => {
  const f = fixture({ visible: false })
  await assert.rejects(prepareOpeningBatchFilter(f.page), /被裁切/)
})

test('ambiguous collapsed forms are rejected without interacting', async () => {
  const f = fixture({ count: 2 })
  await assert.rejects(prepareOpeningBatchFilter(f.page), /多个折叠表单/)
  assert.deepEqual(f.events, [])
})
