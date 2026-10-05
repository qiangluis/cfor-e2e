import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanupCustomField, dataOf } from '../suites/system-custom-field.mjs'

test('custom-field dataOf unwraps envelopes and preserves already-unwrapped values', () => {
  assert.equal(dataOf({ code: 0, data: 123, msg: 'success' }), 123)
  assert.deepEqual(dataOf({ code: 0, data: { status: 'DRAFT' }, msg: 'success' }), {
    status: 'DRAFT'
  })
  assert.deepEqual(dataOf({ code: 0, data: [{ action: 'SUBMIT' }], msg: 'success' }), [
    { action: 'SUBMIT' }
  ])

  const alreadyUnwrapped = { status: 'DRAFT', data: 'business-data' }
  assert.strictEqual(dataOf(alreadyUnwrapped), alreadyUnwrapped)
  assert.equal(dataOf({ code: 0, data: null, msg: 'success' }), null)
})

test('custom-field cleanup rejects pending publish and deletes the resulting draft', async () => {
  let status = 'PENDING_PUBLISH'
  const calls = []
  const api = {
    getBusiness: async (pathname) => {
      calls.push(['getBusiness', pathname])
      return { code: 0, data: { status }, msg: 'success' }
    },
    postBusiness: async (pathname, body) => {
      calls.push(['postBusiness', pathname, body])
      assert.equal(pathname, '/system/custom-field/review-publish')
      assert.equal(body.decision, 'REJECT')
      status = 'DRAFT'
      return { code: 0, data: true, msg: 'success' }
    },
    deleteBusiness: async (pathname) => {
      calls.push(['deleteBusiness', pathname])
      assert.equal(status, 'DRAFT')
      return { code: 0, data: true, msg: 'success' }
    }
  }
  const caseRecord = { notes: [] }

  await cleanupCustomField({ api, fieldId: 123, caseRecord })

  assert.deepEqual(calls.map(([method, pathname]) => [method, pathname]), [
    ['getBusiness', '/system/custom-field/get?id=123'],
    ['postBusiness', '/system/custom-field/review-publish'],
    ['getBusiness', '/system/custom-field/get?id=123'],
    ['deleteBusiness', '/system/custom-field/delete?id=123']
  ])
  assert.deepEqual(caseRecord.notes, [])
})

test('custom-field cleanup creates a draft from a published field and records cleanup failures', async () => {
  let status = 'PUBLISHED'
  const calls = []
  const api = {
    getBusiness: async (pathname) => {
      calls.push(['getBusiness', pathname])
      return { code: 0, data: { status }, msg: 'success' }
    },
    postBusiness: async (pathname) => {
      calls.push(['postBusiness', pathname])
      assert.equal(pathname, '/system/custom-field/create-version?id=456')
      status = 'DRAFT'
      return { code: 0, data: true, msg: 'success' }
    },
    deleteBusiness: async () => {
      calls.push(['deleteBusiness'])
      throw new Error('delete denied')
    }
  }
  const caseRecord = { notes: [] }

  await cleanupCustomField({ api, fieldId: 456, caseRecord })

  assert.equal(calls[1][1], '/system/custom-field/create-version?id=456')
  assert.match(caseRecord.notes[0], /PB040-002 清理失败 fieldId=456: delete denied/)
})
