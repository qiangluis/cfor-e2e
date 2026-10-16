#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { loadEnv } from 'vite'
import { config } from './config/index.mjs'
import { loginWithCredentials } from './lib/browser.mjs'
import { unwrapWebStorageValue } from './lib/assertions.mjs'

const webBase = process.env.CFOR_UI_BASE_URL || config.webBase
const apiBase = config.apiBase
for (const base of [webBase, apiBase]) {
  assert.ok(
    ['127.0.0.1', 'localhost'].includes(new URL(base).hostname),
    'This regression runner requires explicitly configured local Web and API addresses'
  )
}
assert.equal(webBase, config.webBase, 'Use CFOR_WEB_BASE for login and route navigation')

const outputDir =
  process.env.CFOR_SETTINGS_SCREENSHOTS || `/tmp/cfor-pb002-pb013-settings/${Date.now()}`
await mkdir(outputDir, { recursive: true })
const browser = await chromium.connectOverCDP(process.env.CFOR_CDP_URL || 'http://127.0.0.1:9222')
const page = await browser.contexts()[0].newPage()
page.setDefaultTimeout(30000)
page.setDefaultNavigationTimeout(60000)
const results = []
const errors = []
const unexpectedWrites = []
const allowFixtures = process.argv.includes('--allow-local-fixtures')
const keepPage = process.argv.includes('--keep-page')
const selectedCases = process.argv
  .filter((argument) => argument.startsWith('--case='))
  .map((argument) => argument.slice('--case='.length))
const printFixtureObject = 'PB010_LOCAL_PRINT_FIXTURE'
const retainedFixtures = []
let token

page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => {
  if (message.type() === 'error' && message.text().startsWith('Vue error:')) {
    errors.push(message.text())
  }
})
await page.route('**/admin-api/**', async (route) => {
  const request = route.request()
  const pathname = new URL(request.url()).pathname
  const allowed =
    request.method() === 'GET' ||
    /\/system\/auth\//.test(pathname) ||
    /\/fillRule\/business\/preview$/.test(pathname) ||
    /\/approval-policy\/preview$/.test(pathname) ||
    (allowFixtures &&
      /\/print-template\/binding\/create$/.test(pathname) &&
      request.postDataJSON()?.objectCode === printFixtureObject)
  if (!allowed) {
    unexpectedWrites.push(`${request.method()} ${pathname}`)
    await route.abort()
    return
  }
  await route.continue()
})

const request = async (method, pathname, data, accessToken) => {
  if (accessToken === undefined) {
    // The SPA may refresh its access token while the same browser session is reused.
    accessToken = unwrapWebStorageValue(
      await page.evaluate(() => localStorage.getItem('ACCESS_TOKEN'))
    )
  }
  let response
  try {
    response = await page.request.fetch(`${apiBase}/admin-api${pathname}`, {
      method,
      headers: {
        'tenant-id': String(config.tenantId),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
      },
      ...(data === undefined ? {} : { data }),
      timeout: 20000
    })
  } catch (error) {
    throw new Error(`${method} ${pathname}: ${error.message.split('\n')[0]}`)
  }
  assert.equal(response.status(), 200, `${method} ${pathname}: HTTP ${response.status()}`)
  return response.json()
}
const business = async (method, pathname, data) => {
  const payload = await request(method, pathname, data)
  assert.ok([0, 200].includes(payload.code), `${pathname}: ${payload.code} ${payload.msg || ''}`)
  return payload.data ?? payload.result
}
const navigate = async (target) => {
  await page.waitForFunction(
    () => Boolean(document.querySelector('#app')?.__vue_app__?.config.globalProperties.$router),
    undefined,
    { timeout: 30000 }
  )
  await page.evaluate(async (destination) => {
    await document
      .querySelector('#app')
      .__vue_app__.config.globalProperties.$router.push(destination)
  }, target)
  await page.locator('.route-skeleton:visible').waitFor({ state: 'hidden', timeout: 60000 })
}
const screenshot = async (name) => {
  const filename = path.join(outputDir, `${name}.png`)
  await page.screenshot({ path: filename, animations: 'disabled' })
  return filename
}
const run = async (name, action) => {
  if (selectedCases.length && !selectedCases.some((selected) => name.startsWith(`${selected}:`))) {
    return
  }
  const startedAt = Date.now()
  const errorCount = errors.length
  try {
    const evidence = await action()
    assert.equal(errors.length, errorCount, errors.slice(errorCount).join('\n'))
    results.push({ name, status: 'PASS', durationMs: Date.now() - startedAt, evidence })
  } catch (error) {
    const image = await screenshot(`failure-${results.length + 1}`).catch(() => undefined)
    results.push({
      name,
      status: 'FAIL',
      durationMs: Date.now() - startedAt,
      error: error.message,
      screenshot: image
    })
    console.log(error.message)
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
    await page
      .locator('[class*="-user-info"]')
      .first()
      .waitFor()
      .catch(() => {})
  }
  console.log(`${results.at(-1).status}: ${name}`)
}

try {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`${webBase}/index`, { waitUntil: 'domcontentloaded' })
  token = unwrapWebStorageValue(await page.evaluate(() => localStorage.getItem('ACCESS_TOKEN')))
  const permission = token
    ? await request('GET', '/system/auth/get-permission-info')
    : { code: 401 }
  if (permission.code !== 0) {
    const environment = loadEnv('env.local', process.cwd(), 'VITE_APP_API_ENCRYPT')
    process.env.CFOR_API_ENCRYPT_RESPONSE_KEY ||= environment.VITE_APP_API_ENCRYPT_RESPONSE_KEY
    await page.evaluate(() => {
      localStorage.removeItem('ACCESS_TOKEN')
      localStorage.removeItem('REFRESH_TOKEN')
    })
    token = await loginWithCredentials(page)
  }
  await page.waitForFunction(
    () => Boolean(document.querySelector('#app')?.__vue_app__?.config.globalProperties.$router),
    undefined,
    { timeout: 30000 }
  )
  await page.locator('[class*="-user-info"]').first().waitFor({ timeout: 30000 })

  await run('PB007: industry position templates can be previewed and cancelled', async () => {
    await navigate('/system/post')
    await page.getByRole('button', { name: '行业模板', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '行业岗位模板', exact: true })
    await dialog.waitFor()
    await dialog.locator('.el-table__body-wrapper .el-table__row').first().waitFor()
    const image = await screenshot('position-template')
    const rows = await dialog.locator('.el-table__body-wrapper .el-table__row').count()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    return { rows, screenshot: image }
  })

  await run(
    'PB008: account directory exposes employee links and existing-account onboarding',
    async () => {
      await navigate('/system/user')
      await page.getByRole('columnheader', { name: 'HRM档案', exact: true }).waitFor()
      await page.locator('.el-table__body-wrapper .el-table__row').first().waitFor()
      await page.getByRole('button', { name: '建档', exact: true }).first().click()
      const form = page.getByRole('dialog', { name: /从后台用户.*建档/ })
      await form.waitFor()
      assert.match(await form.innerText(), /后台用户|登录账号/)
      const image = await screenshot('employee-from-account')
      await form.getByRole('button', { name: '取消', exact: true }).click()
      return { screenshot: image, saved: false }
    }
  )

  await run(
    'PB009: shared workflow bills have independent selection and Chinese names',
    async () => {
      await navigate('/system/bus-config')
      await page.getByRole('tab', { name: '审批流', exact: true }).click()
      const workspace = page.locator('.unified-approval-policy')
      const tree = workspace.locator('.object-tree')
      await tree.locator('.tree-node.is-leaf').first().waitFor()
      await page.waitForFunction(
        () => !document.querySelector('.policy-workspace .el-loading-mask')
      )
      const names = await tree.locator('.tree-node.is-leaf .tree-node-label').allTextContents()
      assert.ok(names.includes('借用归还单'))
      assert.ok(names.includes('跨仓调拨单'))
      assert.ok(names.includes('生产退料'))
      assert.ok(!names.some((name) => /^Mes|^Wms/.test(name)))
      await tree.getByText('借用归还单', { exact: true }).click()
      await workspace.locator('.object-title').filter({ hasText: '借用归还单' }).waitFor()
      assert.doesNotMatch(await workspace.locator('.object-header').innerText(), /Wms|ERP_STOCK/)
      const manualMode = workspace.locator('.mode-item').first().locator('.el-select')
      await manualMode.click()
      await page.getByRole('option', { name: '免审', exact: true }).click()
      await tree.getByText('跨仓调拨单', { exact: true }).click()
      await workspace.locator('.object-title').filter({ hasText: '跨仓调拨单' }).waitFor()
      assert.match(await workspace.locator('.mode-item').first().innerText(), /流程审批/)
      await tree.getByText('借用归还单', { exact: true }).click()
      assert.match(await workspace.locator('.mode-item').first().innerText(), /免审/)
      const image = await screenshot('approval-independent-bills')
      // Reload discards the unsaved selection changes.
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.locator('[class*="-user-info"]').first().waitFor()
      return { names, screenshot: image, saved: false }
    }
  )

  await run('PB011: legacy deep link, readable rules and five-digit live preview', async () => {
    await navigate('/mes/styCode?settingsRegression=1#numbering')
    assert.equal(new URL(page.url()).pathname, '/system/styCode')
    assert.equal(new URL(page.url()).searchParams.get('settingsRegression'), '1')
    assert.equal(new URL(page.url()).hash, '#numbering')
    await page.locator('.number-rules-layout .el-table__row').first().waitFor()
    const active = await page
      .locator('.el-menu--horizontal .el-menu-item.is-active')
      .allTextContents()
    assert.ok(active.some((label) => label.trim() === '设置'))
    const text = await page.locator('.number-rules-layout').innerText()
    assert.doesNotMatch(text, /ruleClass|ruleParams|CONSTANT|SEQUENCE/)
    const image = await screenshot('number-rules')
    await page.getByRole('button', { name: '新增', exact: true }).click()
    const dialog = page
      .getByRole('dialog')
      .filter({ has: page.getByText('实时预览', { exact: true }) })
    await dialog.waitFor()
    await dialog
      .locator('.el-form-item')
      .filter({ hasText: '业务对象' })
      .locator('.el-select')
      .click()
    await page.getByRole('option', { name: '基础档案 / 客户', exact: true }).click()
    assert.equal(await dialog.getByRole('spinbutton').inputValue(), '5')
    await dialog.locator('.preview-box').filter({ hasText: /00001/ }).waitFor()
    const preview = await dialog.locator('.preview-box').innerText()
    assert.doesNotMatch(await dialog.innerText(), /实现类|JSON|规则编码/)
    const formImage = await screenshot('number-rule-preview')
    await dialog.getByRole('button', { name: '取 消', exact: true }).click()
    return { preview, screenshots: [image, formImage], saved: false }
  })

  await run('PB010: published template binding uses partner selection', async () => {
    const existing = await business(
      'GET',
      `/system/print-template/page?pageNo=1&pageSize=100&objectCode=${printFixtureObject}`
    )
    let template = existing.list.find((item) => item.status === 'PUBLISHED')
    if (!template && allowFixtures) {
      let draft = existing.list.find((item) => item.status === 'DRAFT')
      if (!draft) {
        const id = await business('POST', '/system/print-template/create', {
          name: 'PB010 本地验证模板（隔离对象）',
          description: '本地浏览器回归夹具，独立对象，不用于正式单据',
          billType: '2',
          objectCode: printFixtureObject,
          templateCode: printFixtureObject,
          json: '{"panels":[]}'
        })
        draft = { id }
      }
      await business('PUT', `/system/print-template/publish?id=${draft.id}&makeDefault=false`)
      template = await business('GET', `/system/print-template/get?id=${draft.id}`)
    }
    assert.ok(template, 'No published regression template; use --allow-local-fixtures')
    retainedFixtures.push({ objectCode: printFixtureObject, templateId: template.id })
    await navigate('/infra/print/index')
    await page.getByPlaceholder('请输入模板名称').waitFor({ timeout: 60000 })
    await page.getByPlaceholder('请输入模板名称').fill('PB010 本地验证模板')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await page.getByRole('button', { name: '绑定', exact: true }).first().click()
    const bindings = page.getByRole('dialog', { name: '打印模板绑定', exact: true })
    await bindings.waitFor()
    await bindings.getByRole('button', { name: '新增绑定', exact: true }).click()
    const form = page.getByRole('dialog', { name: '新增绑定', exact: true })
    await form.waitFor()
    await form.locator('.el-form-item').filter({ hasText: '绑定值' }).locator('.el-select').click()
    await page.getByRole('option').first().waitFor()
    const count = await page.getByRole('option').count()
    assert.ok(count > 0)
    await page.getByRole('option').first().click()
    const image = await screenshot('print-partner-selection')
    if (allowFixtures) {
      try {
        await form.getByRole('button', { name: '保存', exact: true }).click()
        await form.waitFor({ state: 'hidden' })
        const saved = await business(
          'GET',
          `/system/print-template/binding/page?pageNo=1&pageSize=100&objectCode=${printFixtureObject}`
        )
        assert.equal(saved.list.length, 1)
        assert.equal(String(saved.list[0].templateId), String(template.id))
        assert.equal(saved.list[0].dimensionType, 'CUSTOMER')
      } finally {
        const saved = await business(
          'GET',
          `/system/print-template/binding/page?pageNo=1&pageSize=100&objectCode=${printFixtureObject}`
        )
        for (const binding of saved.list) {
          await business('DELETE', `/system/print-template/binding/delete?id=${binding.id}`)
        }
      }
    } else {
      await form.getByRole('button', { name: '取消', exact: true }).click()
    }
    // The shared Dialog uses a custom header; Escape closes it through the component API.
    await page.keyboard.press('Escape')
    await bindings.waitFor({ state: 'hidden', timeout: 60000 })
    return {
      partnerOptions: count,
      screenshot: image,
      bindingSavedAndRemoved: allowFixtures,
      templateId: template.id
    }
  })

  await run(
    'PB013: unregistered config and fields are rejected without changing stored values',
    async () => {
      const before = await business('GET', '/system/config/get?category=global&tag=common')
      for (const [url, configData] of [
        ['/system/config/save?category=unregisteredE2E&tag=unregisteredE2E', '{}'],
        ['/system/config/save?category=global&tag=common', '{"unregisteredE2E":true}']
      ]) {
        const response = await request('POST', url, { configData })
        assert.equal(response.code, 400)
        assert.match(response.msg, /未登记/)
      }
      const after = await business('GET', '/system/config/get?category=global&tag=common')
      assert.equal(after.configData, before.configData)
      return { rejectedWrites: 2, storedValueUnchanged: true }
    }
  )

  await run('PB012: platform tenant restriction remains explicit under Settings', async () => {
    assert.equal(String(config.tenantId), '1', 'This check targets the platform tenant boundary')
    await navigate('/settings/business-settings/ai-model')
    await page
      .getByText(/切换.*企业租户/)
      .first()
      .waitFor()
    const active = await page
      .locator('.el-menu--horizontal .el-menu-item.is-active')
      .allTextContents()
    assert.ok(active.some((label) => label.trim() === '设置'))
    return {
      screenshot: await screenshot('enterprise-ai-boundary'),
      enterpriseModelInvocation: 'NOT_TESTED'
    }
  })

  if (allowFixtures) {
    await run('PB007: delete, recreate and delete the same position code', async () => {
      const code = `PB007${Date.now()}`
      let postId
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          postId = await business('POST', '/system/post/create', {
            code,
            name: code,
            sort: 999,
            status: 0,
            remark: '本地软删除唯一键回归'
          })
          await business('DELETE', `/system/post/delete?id=${postId}`)
          postId = undefined
        }
        const records = await business('GET', `/system/post/page?pageNo=1&pageSize=1&code=${code}`)
        assert.equal(records.total, 0)
        return { cycles: 2, activeRecordsAfterCleanup: 0 }
      } finally {
        if (postId) await business('DELETE', `/system/post/delete?id=${postId}`)
      }
    })

    await run(
      'PB005: zero-role account cannot read or change users or print templates',
      async () => {
        const username = `pb005${Date.now()}`
        const password = `T9${randomBytes(5).toString('hex')}!`
        let userId
        try {
          userId = await business('POST', '/system/user/create', {
            username,
            password,
            nickname: '权限负向临时验证',
            roleIds: [],
            postIds: []
          })
          const login = await request('POST', '/system/auth/login', { username, password }, null)
          assert.equal(login.code, 0, login.msg)
          const restrictedToken = login.data.accessToken
          const permissions = await request(
            'GET',
            '/system/auth/get-permission-info',
            undefined,
            restrictedToken
          )
          assert.equal(permissions.code, 0)
          assert.deepEqual(permissions.data.roles, [])
          // Directory menus may be returned with an empty permission marker.
          // They do not grant an executable action and must not make the
          // zero-role negative case fail.
          const executablePermissions = (permissions.data.permissions || []).filter(
            (permission) => String(permission || '').trim().length > 0
          )
          assert.deepEqual(executablePermissions, [])
          const endpoints = [
            ['GET', '/system/user/page?pageNo=1&pageSize=1'],
            ['GET', `/system/user/get?id=${userId}`],
            ['GET', '/system/print-template/page?pageNo=1&pageSize=1'],
            ['GET', '/system/print-template/reference/page?pageNo=1&pageSize=1'],
            ['PUT', '/system/user/update-status', { id: userId, status: 1 }]
          ]
          for (const [method, url, body] of endpoints) {
            const result = await request(method, url, body, restrictedToken)
            assert.equal(result.code, 403, `${method} ${url}: ${result.code}`)
          }
          return { roles: 0, permissions: 0, deniedEndpoints: endpoints.length }
        } finally {
          if (userId) await business('DELETE', `/system/user/delete?id=${userId}`)
        }
      }
    )
  }
  assert.ok(results.length > 0, 'No regression cases matched the requested selection')
  assert.deepEqual(unexpectedWrites, [])
} catch (error) {
  results.push({ name: 'environment and runner guards', status: 'FAIL', error: error.message })
  console.log(`FAIL: ${error.message}`)
} finally {
  if (!keepPage) await page.close()
  await browser.close()
  await writeFile(
    path.join(outputDir, 'result.json'),
    JSON.stringify({ selectedCases, results, errors, unexpectedWrites, retainedFixtures }, null, 2)
  )
}
console.log(`Report: ${path.join(outputDir, 'result.json')}`)
if (results.some((result) => result.status === 'FAIL') || errors.length) process.exitCode = 1
