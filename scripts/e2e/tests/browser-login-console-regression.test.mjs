import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { config } from '../config/index.mjs'
import { login, observePage } from '../lib/browser.mjs'

const reusableToken = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function visibleLocator ({ onClick } = {}) {
  return {
    first () { return this },
    async waitFor () {},
    async isVisible () { return true },
    async fill () {},
    async press () {},
    async click () { await onClick?.() },
    getByRole () { return this }
  }
}

function rejectedLoginPage () {
  let url = 'about:blank'
  let pollCount = 0
  let submitCount = 0
  const page = {
    url: () => url,
    goto: async (target) => { url = target },
    waitForFunction: async () => {},
    locator: (selector) => {
      if (selector === 'button:has-text("账密登录")') {
        return {
          first () { return this },
          async isVisible () { return false },
          async click () { assert.fail('hidden account tab must not be clicked') }
        }
      }
      if (selector === '.portal-login-card') {
        return {
          first () { return this },
          getByRole: () => visibleLocator({ onClick: () => { submitCount++ } })
        }
      }
      return visibleLocator()
    },
    waitForResponse: async () => ({
      url: () => `${config.apiBase}/admin-api/system/auth/login-encrypted`,
      request: () => ({ method: () => 'POST' }),
      headers: () => ({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({
        code: 1002000000,
        msg: '用户名或密码错误',
        data: null
      })
    }),
    waitForTimeout: async () => {
      pollCount++
      throw new Error('business rejection must not enter the 90-second login poll')
    }
  }
  return {
    page,
    get pollCount () { return pollCount },
    get submitCount () { return submitCount }
  }
}

test('login business rejection fails before the 90-second token and route poll', async () => {
  const state = rejectedLoginPage()

  await assert.rejects(
    login(state.page, {
      credentials: {
        tenantName: 'CFOR 标准平台',
        username: 'invalid-user',
        password: 'invalid-password'
      }
    }),
    /1002000000.*用户名或密码错误/
  )

  assert.equal(state.submitCount, 1)
  assert.equal(state.pollCount, 0)
})

test('flushResponses waits for asynchronous console Error stack collection', async () => {
  const page = new EventEmitter()
  const record = { consoleErrors: [], consoleErrorDetails: [] }
  const observer = observePage(page, record)
  let releaseDetails
  const detailsReady = new Promise((resolve) => { releaseDetails = resolve })

  page.emit('console', {
    type: () => 'error',
    text: () => 'Uncaught Error: approval detail failed',
    location: () => ({
      url: `${config.webBase}/src/views/bpm/detail.ts`,
      lineNumber: 27,
      columnNumber: 11
    }),
    args: () => [{ evaluate: async () => detailsReady }]
  })

  let flushed = false
  const flushing = observer
    .flushResponses({ timeoutMs: 1000, quietMs: 0 })
    .then(() => { flushed = true })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(flushed, false)
  assert.deepEqual(record.consoleErrors, ['Uncaught Error: approval detail failed'])
  assert.equal(record.consoleErrorDetails[0].errors, undefined)

  releaseDetails({
    name: 'Error',
    message: 'approval detail failed',
    stack: 'Error: approval detail failed\n    at loadDetail (detail.ts:27:11)'
  })
  await flushing

  assert.deepEqual(record.consoleErrorDetails, [{
    text: 'Uncaught Error: approval detail failed',
    url: `${config.webBase}/src/views/bpm/detail.ts`,
    line: 27,
    column: 11,
    errors: [{
      name: 'Error',
      message: 'approval detail failed',
      stack: 'Error: approval detail failed\n    at loadDetail (detail.ts:27:11)'
    }]
  }])
})

test('login keeps the reusable business-page session path free of navigation and submission', async () => {
  const steps = []
  const page = {
    url: () => `${config.webBase}/systemInit/index`,
    context: () => ({ cookies: async () => [] }),
    evaluate: async () => [[
      'ACCESS_TOKEN',
      JSON.stringify({ v: reusableToken })
    ]],
    goto: async () => assert.fail('reusable session must not navigate'),
    locator: () => assert.fail('reusable business-page session must not inspect login controls'),
    waitForResponse: async () => assert.fail('reusable session must not submit login')
  }

  const token = await login(page, {
    check: { step: (...args) => steps.push(args) }
  })

  assert.equal(token, reusableToken)
  assert.deepEqual(steps, [[
    'page',
    '复用当前登录会话',
    true,
    `${config.webBase}/systemInit/index`
  ]])
})
