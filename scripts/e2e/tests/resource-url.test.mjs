import assert from 'node:assert/strict'
import test from 'node:test'
import { resourceUrl } from '../lib/redact.mjs'

test('resource diagnostics remove query tokens, fragments and URL credentials', () => {
  assert.equal(
    resourceUrl('http://user:secret@127.0.0.1:48083/infra/ws?token=secret#private'),
    'http://127.0.0.1:48083/infra/ws'
  )
})

test('invalid resource locations do not expose their original text', () => {
  assert.equal(resourceUrl('password=secret'), '[unavailable]')
  assert.equal(resourceUrl(''), '[unavailable]')
})
