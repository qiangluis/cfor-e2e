import assert from 'node:assert/strict'
import test from 'node:test'
import { hasProjectFixture, isBusinessRejected } from '../suites/project-after-sales.mjs'

test('project-after-sales recognizes business rejection in an HTTP-success response', () => {
  assert.equal(
    isBusinessRejected({ code: 400, data: null, msg: '引用中不能删除' }, 400, '不能删除'),
    true
  )
  assert.equal(isBusinessRejected({ code: 0, data: true }, 400, '不能删除'), false)
  assert.equal(isBusinessRejected({ code: 200, success: true, data: true }, 400, '不能删除'), false)
})

test('project-after-sales distinguishes missing project facts from a failed page response', () => {
  assert.equal(hasProjectFixture({ code: 0, data: { list: [] } }), false)
  assert.equal(hasProjectFixture({ code: 0, data: { list: [{ id: 1 }] } }), true)
  assert.equal(hasProjectFixture({ code: 0, data: [] }), false)
})
