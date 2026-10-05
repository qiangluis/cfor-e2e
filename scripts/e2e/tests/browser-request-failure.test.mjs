import test from 'node:test'
import assert from 'node:assert/strict'
import { isExpectedRequestFailure } from '../lib/browser.mjs'

test('ignores only aborted media requests caused by expected page teardown', () => {
  assert.equal(
    isExpectedRequestFailure({
      resourceType: 'media',
      error: 'net::ERR_ABORTED',
      url: 'http://127.0.0.1:9151/ai-human/digital-human-idle.webm'
    }),
    true
  )
  assert.equal(
    isExpectedRequestFailure({
      resourceType: 'media',
      error: 'net::ERR_ABORTED',
      url: 'http://127.0.0.1:9151/assets/other-video.webm'
    }),
    false
  )
  assert.equal(
    isExpectedRequestFailure({
      resourceType: 'media',
      error: 'net::ERR_FAILED'
    }),
    false
  )
  assert.equal(
    isExpectedRequestFailure({
      resourceType: 'script',
      error: 'net::ERR_ABORTED'
    }),
    false
  )
})
