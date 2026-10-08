import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from '../config/index.mjs'
import { login, waitForPageReady } from '../lib/browser.mjs'

const token = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function pageWithToken (initialPath) {
  let url = initialPath === 'about:blank' ? initialPath : `${config.webBase}${initialPath}`
  const visits = []
  const context = { cookies: async () => [] }
  return {
    visits,
    url: () => url,
    context: () => context,
    evaluate: async () => [['ACCESS_TOKEN', JSON.stringify({ v: token })]],
    goto: async (target) => { visits.push(target); url = target },
    locator: () => ({
      first: () => ({ waitFor: async () => {} })
    })
  }
}

test('reuses a token before the /login guard finishes redirecting', async () => {
  const page = pageWithToken('/login')
  assert.equal(await login(page), token)
  assert.deepEqual(page.visits, [`${config.webBase}/index`])
})

test('an untouched page reuses authentication performed on a sibling page', async () => {
  const page = pageWithToken('about:blank')
  assert.equal(await login(page), token)
  assert.deepEqual(page.visits, [`${config.webBase}/login`, `${config.webBase}/index`])
})

test('a business page reuses the session without navigating or submitting login', async () => {
  const page = pageWithToken('/systemInit/index')
  assert.equal(await login(page), token)
  assert.deepEqual(page.visits, [])
})

test('page readiness supplies timeout in the Playwright options argument', async () => {
  let args
  const page = { waitForFunction: async (...values) => { args = values } }
  await waitForPageReady(page, 12345)
  assert.equal(args[1], undefined)
  assert.deepEqual(args[2], { timeout: 12345 })
})
