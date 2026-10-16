import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { observePage } from '../lib/browser.mjs'
import { encryptRequest, ENCRYPT_HEADER } from '../lib/crypto.mjs'
import { newReminderFixture } from '../fixtures/project-after-sales-reminder-closure.mjs'
import {
  assertReminderRuleForm,
  assertReminderDelayForm,
  assertReminderRuleWrite,
  readReminderRuleForm,
  verifyReminderRuleQuietHoursInBrowser
} from '../fixtures/project-after-sales-reminder-browser.mjs'

const local = {
  target: 'local', tenantId: '1', apiBase: 'http://127.0.0.1:48083',
  webBase: 'http://127.0.0.1:9151',
  db: { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard' }
}
const id = '2109000000000000124'
const success = (data) => ({ code: 0, data })
const fields = {
  模型编码: 'ruleCode', 模型名称: 'ruleName',
  免打扰开始: 'quietHoursStart', 免打扰结束: 'quietHoursEnd',
  到期前提醒: 'firstDelayMinutes'
}
const storedRow = (body) => {
  const row = { ...structuredClone(body), id, tenantId: '1', status: 'ENABLED', version: 0 }
  for (const key of ['applicableStatuses', 'channels', 'receiverTypes']) {
    row[`${key}Json`] = JSON.stringify(body[key])
    delete row[key]
  }
  return row
}
const rowBody = (row) => {
  const { id, tenantId, status, version, ...body } = structuredClone(row)
  for (const key of ['applicableStatuses', 'channels', 'receiverTypes']) {
    body[key] = JSON.parse(body[`${key}Json`])
    delete body[`${key}Json`]
  }
  return body
}
const responseFor = (body, options = {}) => {
  const request = {
    method: () => options.method || 'PUT',
    url: () => options.url ||
      `http://127.0.0.1:48083/admin-api/after-sales/modeling/reminder-rule/update?id=${id}`,
    headers: () => ({
      'tenant-id': options.tenant ?? '1',
      ...(options.encrypted ? { [ENCRYPT_HEADER.toLowerCase()]: 'true' } : {})
    }),
    postDataJSON: () => structuredClone(body),
    postData: () => encryptRequest(body)
  }
  return {
    request: () => request, url: request.url,
    ok: () => !options.httpFailure, status: () => options.httpFailure || 200,
    headers: () => ({ 'content-type': 'application/json' }),
    text: async () => {
      options.onBody?.()
      if (options.bodyFailure) throw new Error('browser response body unavailable')
      await options.bodyGate
      return JSON.stringify(options.business || success(true))
    }
  }
}

const harness = (options = {}) => {
  const fixture = newReminderFixture(new Date('2026-10-13T04:00:00Z'))
  fixture.assetId = '300'
  const rule = { id, body: {
    ruleCode: `${fixture.marker}-RULE`, ruleName: fixture.marker,
    reminderScene: 'ASSET_SERVICE_DUE', applicableStatuses: ['IN_SERVICE', 'SERVICE_EXPIRED'],
    firstDelayMinutes: 30, repeatEnabled: true, repeatIntervalMinutes: 720, maxTimes: 2,
    channels: ['SYSTEM'], receiverTypes: ['HANDLER'], stopCondition: 'SERVICE_RENEWED',
    messageTemplate: fixture.marker, idempotencyKeyTemplate: 'PB124:{ruleId}:{bizType}:{bizId}:{sequence}',
    quietHoursStart: '22:00', quietHoursEnd: '08:00', remark: fixture.marker
  } }
  fixture.rules.push(rule)
  const originalBody = structuredClone(rule.body)
  const record = { caseId: 'PB124-001', checks: [], notes: [], api: [],
    failedApiResponses: [], consoleErrors: [], pageErrors: [] }
  const events = [], browserWrites = [], apiWrites = []
  const page = new EventEmitter()
  let stored = storedRow(rule.body), form, dialogVisible = false, warningVisible = false
  let hovered, filterCode, address = `${local.webBase}/index`, waiter
  let pickerVisible = false, pickerOriginal
  let reloadCount = 0, readCount = 0, singleClicks = 0
  page.url = () => address
  page.context = () => assert.fail('must reuse supplied page; no browser context access')
  page.route = () => assert.fail('must not inject browser responses')
  page.goto = async (url) => {
    events.push(['goto', url])
    address = url
    assert.equal(new URL(url).pathname, '/after-sales/settings', 'must not log in again')
    emitRead()
  }
  page.reload = async (args) => {
    assert.deepEqual(args, { waitUntil: 'domcontentloaded' })
    events.push(['reload', ++reloadCount])
    dialogVisible = false
    warningVisible = false
    emitRead()
  }
  page.waitForFunction = async () => {}
  page.evaluate = async () => { events.push(['clear-local-state']); return [] }
  page.waitForResponse = (predicate) => new Promise((resolve, reject) => {
    assert.equal(waiter, undefined, 'only one response waiter on the supplied page')
    waiter = { predicate, resolve, reject }
  })
  const emitResponse = (response) => {
    page.emit('request', response.request())
    page.emit('response', response)
    page.emit('requestfinished', response.request())
    if (waiter) {
      const pending = waiter
      waiter = undefined
      if (pending.predicate(response)) pending.resolve(response)
      else pending.reject(new Error('owned update response did not arrive'))
    }
  }
  const emitRead = () => emitResponse(responseFor(null, {
    method: 'GET',
    url: 'http://127.0.0.1:48083/admin-api/after-sales/modeling/reminder-rule/list',
    business: success(options.browserRows || [structuredClone(stored)]),
    ...options.browserRead
  }))
  const emitWrite = (payload) => {
    const response = responseFor(payload, options.response || {})
    browserWrites.push(response.request())
    emitResponse(response)
  }
  const save = async () => {
    events.push(['save', structuredClone(form)])
    const isSingle = (form.quietHoursStart === null) !== (form.quietHoursEnd === null)
    if (isSingle) {
      singleClicks++
      warningVisible = !options.missingWarning
      if (options.singleWrites) {
        stored = { ...storedRow(form), version: stored.version + 1 }
        emitWrite(form)
      }
      if (options.delayedSingleWrite) {
        setImmediate(() => emitWrite(form))
      }
      return
    }
    const payload = structuredClone(form)
    if (options.templateRewrite) {
      payload.idempotencyKeyTemplate = `REM:${payload.ruleCode}:{{ticketId}}:{{occurrence}}`
    }
    options.mutatePayload?.(payload, browserWrites.length)
    if (!options.noPersistence) stored = { ...storedRow(payload), version: stored.version + 1 }
    if (options.serverOverrides) stored = { ...stored, ...options.serverOverrides }
    if (!options.dialogStuck) dialogVisible = false
    emitWrite(payload)
    if (options.duplicateWrites) emitWrite(payload)
  }
  const dialog = {
    page: () => page,
    waitFor: async ({ state }) => {
      assert.equal(dialogVisible, state === 'visible', `dialog must be ${state}`)
    },
    getByRole: (role, args) => {
      assert.equal(role, 'button')
      assert.equal(args.exact, true)
      assert.ok(['保存', '取消'].includes(args.name))
      return { click: async () => {
        if (args.name === '保存') return save()
        events.push(['cancel'])
        dialogVisible = false
      } }
    },
    locator: (selector) => {
      assert.equal(selector, '.el-form-item')
      return { filter: ({ has }) => {
        assert.equal(has.kind, 'label')
        const labels = Object.keys(fields).filter((label) => has.regex.test(label))
        assert.equal(labels.length, 1, 'must use an exact existing form label')
        const key = fields[labels[0]]
        return { locator: (selector) => {
          if (selector === '.el-select__selected-item:not(.el-select__input-wrapper)') return {
            innerText: async () => options.displayUnit || '分钟'
          }
          if (selector === 'input') return { first: () => ({
            inputValue: async () => form[key] === null ? '' : String(form[key]),
            click: async () => {
              assert.equal(key, 'quietHoursStart')
              pickerVisible = true
              pickerOriginal = form[key]
              events.push(['open-picker'])
            },
            fill: async (value) => {
              assert.equal(key, 'ruleName', 'only the name may be typed in this workflow')
              form[key] = value
              events.push(['fill', key, value])
            },
            hover: async () => { hovered = key; events.push(['hover', key]) }
          }) }
          assert.equal(selector, '.el-date-editor .clear-icon')
          return {
            count: async () => options.clearCount ?? 1,
            waitFor: async ({ state }) => {
              assert.equal(state, 'visible')
              assert.equal(hovered, key, 'must hover the owned time picker before clearing')
              assert.notEqual(form[key], null)
            },
            click: async () => {
              assert.ok(['quietHoursStart', 'quietHoursEnd'].includes(key))
              events.push(['clear', key])
              form[key] = null
              if (options.clearWrites) emitWrite(form)
            }
          }
        } }
      } }
    }
  }
  const row = {
    count: async () => options.rowCount ?? 1,
    waitFor: async ({ state }) => {
      assert.equal(state, 'visible')
      assert.equal(filterCode, rule.body.ruleCode, 'must filter to the dedicated exact rule')
    },
    getByRole: (role, args) => {
      assert.equal(role, 'button')
      assert.deepEqual(args, { name: '编辑', exact: true })
      return { click: async () => {
        events.push(['edit', id])
        dialogVisible = true
        form = rowBody(stored)
        if (options.uiOverrides && reloadCount === 1) Object.assign(form, options.uiOverrides)
      } }
    }
  }
  page.getByPlaceholder = (value) => {
    assert.equal(value, '编码 / 名称 / 适用范围')
    return { fill: async (value) => { filterCode = value } }
  }
  page.locator = (selector, args) => {
    if (selector === '.el-time-panel:visible') return {
      waitFor: async ({ state }) => assert.equal(pickerVisible, state === 'visible'),
      count: async () => options.pickerCount ?? 1,
      locator: (selector) => {
        if (selector === '.el-scrollbar') return { count: async () => options.scrollbars ?? 0 }
        if (selector === '.el-time-panel__btn.cancel') return { click: async () => {
          form.quietHoursStart = pickerOriginal
          pickerVisible = false
          events.push(['cancel-picker'])
        } }
        assert.equal(selector, '.el-time-spinner__wrapper.is-arrow')
        return {
          count: async () => options.arrowColumns ?? 2,
          nth: (index) => {
            assert.equal(index, 1)
            return {
              hover: async () => events.push(['hover-minute']),
              locator: (selector) => ({ click: async () => {
                assert.ok(['.arrow-down', '.arrow-up'].includes(selector))
                form.quietHoursStart = selector === '.arrow-down' ? '22:01' : '22:00'
                events.push(['picker-arrow', selector])
              } })
            }
          }
        }
      }
    }
    if (selector === '.el-form-item__label') return { kind: 'label', regex: args.hasText }
    if (selector === 'td .cell') return { kind: 'code', regex: args.hasText }
    if (selector === '.el-dialog:visible') return { last: () => dialog }
    if (selector === '.reminder-table .el-table__row') return { filter: ({ has }) => {
      assert.equal(has.kind, 'code')
      assert.equal(has.regex.test(rule.body.ruleCode), true)
      assert.equal(has.regex.test(`${rule.body.ruleCode}-FOREIGN`), false)
      return row
    } }
    if (selector === '.el-tabs__item') return { filter: ({ hasText }) => {
      assert.equal(hasText, '提醒规则')
      return { first: () => ({
        waitFor: async () => {},
        click: async () => events.push(['tab', hasText])
      }) }
    } }
    if (selector === '.el-message--warning .el-message__content') return { filter: ({ hasText }) => ({
      waitFor: async ({ state }) => {
        assert.equal(hasText.test('请同时设置免打扰开始和结束时间，或同时清空'), true)
        assert.equal(hasText.test('其他校验失败'), false)
        if (state === 'hidden') warningVisible = false
        else assert.equal(warningVisible, true, 'must show the exact pair validation warning')
      }
    }) }
    assert.ok(['body', '.modeling-panel', '.modeling-panel .el-loading-mask'].includes(selector),
      `unexpected selector: ${selector}`)
    return {
      waitFor: async () => {},
      innerText: async () => '售后建模 提醒规则',
      evaluate: async () => false
    }
  }
  const api = {
    getBusiness: async (path) => {
      assert.equal(path, '/after-sales/modeling/reminder-rule/list')
      events.push(['api-read', ++readCount])
      const rows = [structuredClone(stored)]
      return options.readResponse?.(rows, readCount) || success(rows)
    },
    putBusiness: async (path, body) => {
      assert.equal(path, `/after-sales/modeling/reminder-rule/update?id=${id}`)
      assert.deepEqual(body, originalBody, 'restoration must restore every original field')
      events.push(['api-restore'])
      apiWrites.push({ path, body: structuredClone(body) })
      if (options.restoreFailure) throw new Error('formal API restoration failed')
      stored = { ...storedRow(body), status: stored.status, version: stored.version + 1 }
      if (options.restoreDrift) stored.quietHoursEnd = null
      return options.restoreResponse || success(true)
    },
    postBusiness: async () => assert.fail('no scan/worker/send/status/create allowed in this helper'),
    deleteBusiness: async () => assert.fail('no delete allowed in this helper')
  }
  const observer = observePage(page, record)
  const flush = observer.flushResponses.bind(observer)
  observer.flushResponses = async (args = {}) => {
    events.push(['flush', args.quietMs ?? 50])
    return flush({ timeoutMs: 100, quietMs: 1 })
  }
  const dependencies = {
    config: local, writeEnabled: 'true',
    assertLocalWriteSafety: async () => {
      events.push(['safety'])
      if (options.safetyFailure) throw new Error('write safety preflight failed')
    }
  }
  const run = (overrides = {}) => verifyReminderRuleQuietHoursInBrowser({
    page, api, fixture, rule, caseRecord: record, dependencies,
    capture: async (tag) => events.push(['capture', tag]), ...overrides
  })
  return {
    page, api, fixture, rule, record, originalBody, dependencies, events, browserWrites, apiWrites, run,
    get stored() { return stored }, get singleClicks() { return singleClicks },
    get reloadCount() { return reloadCount }
  }
}

test('PB124 same-page flow preserves cross-midnight hours, rejects each single clear, clears both, restores full config', async () => {
  const h = harness()
  const requestListeners = h.page.listenerCount('request')
  const result = await h.run()
  assert.equal(result.browserQuietHoursVerified, true)
  assert.equal(result.partial, true)
  assert.equal(result.acceptanceComplete, false)
  assert.equal(result.passCandidate, false)
  assert.equal(result.restored, true)
  assert.equal(result.cleanupRequired, false)
  assert.deepEqual(result.originalBody, h.originalBody)
  assert.deepEqual(rowBody(h.stored), h.originalBody)
  assert.deepEqual(h.rule.body, h.originalBody, 'never mutate closure fixture expectations')
  assert.deepEqual(result.preserved.form, {
    ruleCode: h.rule.body.ruleCode, ruleName: `${h.fixture.marker}-UI`,
    quietHoursStart: '22:00', quietHoursEnd: '08:00'
  })
  assert.deepEqual(result.cleared.form, {
    ruleCode: h.rule.body.ruleCode, ruleName: `${h.fixture.marker}-UI`,
    quietHoursStart: '', quietHoursEnd: ''
  })
  assert.deepEqual(result.rejected.map(({ field, writeCount }) => [field, writeCount]),
    [['quietHoursStart', 0], ['quietHoursEnd', 0]])
  assert.equal(h.singleClicks, 2)
  assert.equal(h.browserWrites.length, 2)
  assert.equal(result.requests.length, 2)
  assert.equal(result.requests[0].quietHoursStart, '22:00')
  assert.equal(result.requests[0].quietHoursEnd, '08:00')
  assert.equal(Object.hasOwn(result.requests[1], 'quietHoursStart'), true)
  assert.equal(Object.hasOwn(result.requests[1], 'quietHoursEnd'), true)
  assert.equal(result.requests[1].quietHoursStart, null)
  assert.equal(result.requests[1].quietHoursEnd, null)
  assert.equal(h.apiWrites.length, 1)
  assert.equal(h.reloadCount, 5)
  assert.equal(h.events.filter(([kind]) => kind === 'goto').length, 1)
  assert.equal(h.events.filter(([kind, ms]) => kind === 'flush' && ms === 250).length, 2)
  assert.equal(h.page.listenerCount('request'), requestListeners, 'temporary request observer must detach')
  assert.equal(h.record.checks.length, 5)
  assert.ok(h.record.checks.every((check) => check.passed))
  assert.ok(h.record.notes.some((note) => note.includes('不提升整例状态')))
})

test('PB124 observes encrypted requests using the request key, with exact quiet values and explicit nulls', async () => {
  const h = harness({ response: { encrypted: true } })
  assert.equal((await h.run()).restored, true)
  assert.equal(h.browserWrites.length, 2)
})

test('PB124 records page-error stacks without URL queries and releases the diagnostic listener', async () => {
  const h = harness()
  const listeners = h.page.listenerCount('pageerror')
  let reported = false
  await h.run({ capture: async () => {
    if (reported) return
    reported = true
    const error = new Error('Null input reference')
    error.stack = 'Error: Null input reference\n  at blur (http://127.0.0.1:9151/picker.js:123:4?token=secret)'
    h.page.emit('pageerror', error)
  } })
  assert.equal(h.record.reminderBrowserPageErrors.length, 1)
  assert.match(h.record.reminderBrowserPageErrors[0].stack, /picker\.js:123:4/)
  assert.doesNotMatch(h.record.reminderBrowserPageErrors[0].stack, /token|secret/)
  assert.equal(h.page.listenerCount('pageerror'), listeners)
})

test('PB124 template rewrite is a failure and is fully restored, never approved as name editing', async () => {
  const h = harness({ templateRewrite: true })
  await assert.rejects(h.run(), /exact browser request fields mismatch/)
  assert.deepEqual(rowBody(h.stored), h.originalBody)
  assert.equal(h.record.checks.some((item) => item.name.includes('保留幂等模板')), false)
})

test('PB124 suite cleanup policy leaves explicit evidence and original body for caller finally; no hidden API writes', async () => {
  const h = harness()
  const result = await h.run({ cleanup: 'suite' })
  assert.equal(result.cleanupRequired, true)
  assert.equal(result.restored, false)
  assert.equal(h.apiWrites.length, 0)
  assert.equal(h.stored.quietHoursStart, null)
  assert.equal(h.stored.quietHoursEnd, null)
  assert.deepEqual(h.rule.body, h.originalBody)
  assert.ok(h.record.notes.some((note) => note.includes('suite需在finally清理')))
})

test('PB124 ownership, ID, local write gates and current page are checked before any browser interaction', async () => {
  const variants = [
    (h) => ({ fixture: { ...h.fixture } }),
    (h) => ({ rule: { ...h.rule } }),
    (h) => { h.rule.id = Number(id); return {} },
    (h) => { h.rule.id = '0'; return {} },
    (h) => { h.rule.body.ruleCode = 'SHARED'; return {} },
    (h) => ({ dependencies: { ...h.dependencies, writeEnabled: 'false' } }),
    (h) => ({ dependencies: { ...h.dependencies, writeEnabled: 'TRUE' } }),
    (h) => ({ dependencies: { ...h.dependencies, config: { ...local, tenantId: '2' } } }),
    (h) => ({ dependencies: { ...h.dependencies, config: { ...local, target: 'online' } } }),
    (h) => ({ dependencies: { ...h.dependencies, config: { ...local, apiBase: 'http://127.0.0.1:48080' } } }),
    (h) => ({ dependencies: { ...h.dependencies, config: { ...local, db: { ...local.db, name: 'production' } } } }),
    (h) => { h.page.url = () => 'https://example.test/index'; return {} },
    () => ({ cleanup: 'ignore' }),
    () => ({ caseRecord: { caseId: 'PB125-001', checks: [], notes: [] } }),
    () => ({ renamedName: 'shared-rule' })
  ]
  for (const change of variants) {
    const h = harness()
    await assert.rejects(h.run(change(h)))
    assert.deepEqual(h.events, [])
    assert.equal(h.browserWrites.length + h.apiWrites.length, 0)
  }
})

test('PB124 failed safety, foreign/duplicate/missing API rule, changed fixture and non-cross-midnight hours stop before navigation', async () => {
  for (const options of [
    { safetyFailure: true },
    { readResponse: () => success([]) },
    { readResponse: (rows) => success([...rows, ...rows]) },
    { readResponse: (rows) => success([{ ...rows[0], id: '999' }]) },
    { readResponse: (rows) => success([{ ...rows[0], id: Number(id) }]) },
    { readResponse: (rows) => success([{ ...rows[0], tenantId: '2' }]) },
    { readResponse: (rows) => success([{ ...rows[0], ruleCode: 'SHARED' }]) },
    { readResponse: (rows) => success([{ ...rows[0], status: 'DISABLED' }]) },
    { readResponse: (rows) => success([{ ...rows[0], repeatIntervalMinutes: 1 }]) },
    { readResponse: (rows) => success([{ ...rows[0], channelsJson: null }]) },
    { readResponse: () => ({ code: 500, msg: 'unavailable' }) }
  ]) {
    const h = harness(options)
    await assert.rejects(h.run())
    assert.equal(h.events.some(([kind]) => kind === 'goto'), false)
    assert.equal(h.apiWrites.length + h.browserWrites.length, 0)
  }
  const h = harness()
  h.rule.body.quietHoursStart = '08:00'
  h.stored.quietHoursStart = '08:00'
  await assert.rejects(h.run(), /requires original cross-midnight/)
})

test('PB124 actual form reader uses exact labels, not another field or matching row text', async () => {
  const h = harness()
  await h.run({ cleanup: 'suite' })
  const edit = h.page.locator('.reminder-table .el-table__row').filter({
    has: h.page.locator('td .cell', { hasText: new RegExp(`^${h.rule.body.ruleCode}$`) })
  })
  await edit.getByRole('button', { name: '编辑', exact: true }).click()
  const form = await readReminderRuleForm(h.page.locator('.el-dialog:visible').last())
  assert.equal(form.quietHoursStart, '')
  assert.equal(form.quietHoursEnd, '')
  assert.equal(assertReminderRuleForm(form, { ...h.originalBody, ruleName: `${h.fixture.marker}-UI`,
    quietHoursStart: null, quietHoursEnd: null }), true)
  for (const change of [
    { ruleCode: 'FOREIGN' }, { ruleName: '' }, { quietHoursStart: '22:00' },
    { quietHoursEnd: undefined }, { quietHoursEnd: null }
  ]) assert.throws(() => assertReminderRuleForm({ ...form, ...change }, {
    ...h.originalBody, ruleName: form.ruleName, quietHoursStart: null, quietHoursEnd: null
  }))
})

test('PB124 request identity rejects wrong verb, host, path, ID precision, duplicate query and tenant', () => {
  const h = harness()
  assert.deepEqual(assertReminderRuleWrite(responseFor(h.originalBody), id, h.originalBody, local).payload,
    h.originalBody)
  for (const options of [
    { method: 'POST' }, { tenant: '2' }, { tenant: '' },
    { url: `http://example.test:48083/admin-api/after-sales/modeling/reminder-rule/update?id=${id}` },
    { url: `http://127.0.0.1:48083/admin-api/after-sales/modeling/escalation-rule/update?id=${id}` },
    { url: 'http://127.0.0.1:48083/admin-api/after-sales/modeling/reminder-rule/update?id=999' },
    { url: `http://127.0.0.1:48083/admin-api/after-sales/modeling/reminder-rule/update?id=${Number(id)}` },
    { url: `http://127.0.0.1:48083/admin-api/after-sales/modeling/reminder-rule/update?id=${id}&id=${id}` },
    { url: `http://127.0.0.1:48083/admin-api/after-sales/modeling/reminder-rule/update?id=${id}&tenantId=2` }
  ]) assert.throws(() => assertReminderRuleWrite(responseFor(h.originalBody, options), id, h.originalBody, local))
})

test('PB124 request assertions never accept omission/empty/string-null/coerced quiet values or unrelated field drift', () => {
  const h = harness()
  const expected = { ...h.originalBody, quietHoursStart: null, quietHoursEnd: null }
  for (const change of [
    { quietHoursStart: undefined }, { quietHoursEnd: undefined }, { quietHoursStart: '' },
    { quietHoursEnd: 'null' }, { quietHoursStart: '22:00' },
    { ruleCode: 'OTHER' }, { firstDelayMinutes: 3000 }, { repeatIntervalMinutes: 1 },
    { maxTimes: 0 }, { stopCondition: '' }, { channels: [] }, { receiverTypes: ['SHARED'] },
    { applicableStatuses: ['IN_SERVICE'] }, { messageTemplate: '' }, { remark: null },
    { idempotencyKeyTemplate: null }, { id: '999' }
  ]) assert.throws(() => assertReminderRuleWrite(responseFor({ ...expected, ...change }), id, expected, local))
  const missing = { ...expected }
  delete missing.quietHoursStart
  assert.throws(() => assertReminderRuleWrite(responseFor(missing), id, expected, local))
})

test('PB124 displayed numeric time must represent exact API minutes, never days or percentages by scene', () => {
  for (const [form, minutes] of [
    [{ value: '0', unit: '分钟' }, 0],
    [{ value: '30', unit: '分钟' }, 30],
    [{ value: '90', unit: '分钟' }, 90],
    [{ value: '12', unit: '小时' }, 720],
    [{ value: '2', unit: '天' }, 2880]
  ]) assert.equal(assertReminderDelayForm(form, minutes), true)
  for (const form of [
    { value: '30', unit: '天' }, { value: '30', unit: '%' }, { value: '0.5', unit: '小时' },
    { value: '', unit: '分钟' }, { value: '-30', unit: '分钟' },
    { value: '9007199254740992', unit: '分钟' }
  ]) assert.throws(() => assertReminderDelayForm(form, 30))
})

test('PB124 wrong displayed time units or broken picker cannot pass before any browser write', async () => {
  for (const options of [
    { displayUnit: '天' }, { displayUnit: '%' },
    { pickerCount: 2 }, { arrowColumns: 0 }, { scrollbars: 1 }
  ]) {
    const h = harness(options)
    await assert.rejects(h.run())
    assert.equal(h.apiWrites.length + h.browserWrites.length, 0)
  }
})

test('PB124 page ambiguity and wrong refreshed UI cannot pass even if API persisted correctly', async () => {
  for (const options of [
    { rowCount: 2 }, { rowCount: 0 },
    { uiOverrides: { quietHoursStart: null } },
    { uiOverrides: { quietHoursEnd: '09:00' } },
    { uiOverrides: { ruleCode: 'FOREIGN' } },
    { uiOverrides: { ruleName: 'OLD' } },
    { clearCount: 2 }
  ]) {
    const h = harness(options)
    const before = h.page.listenerCount('request')
    await assert.rejects(h.run())
    assert.equal(h.page.listenerCount('request'), before)
    assert.equal(h.record.checks.some((check) => check.name.includes('双端显式清空')), false)
  }
})

test('PB124 browser HTTP/business/body/dialog failures propagate; attempted writes restore without passing', async () => {
  for (const options of [
    { response: { httpFailure: 403 } },
    { response: { business: { code: 500, msg: 'failed' } } },
    { response: { business: success(false) } },
    { response: { bodyFailure: true } },
    { response: { tenant: '2' } },
    { dialogStuck: true },
    { noPersistence: true },
    { serverOverrides: { quietHoursEnd: '09:00' } },
    { serverOverrides: { status: 'DISABLED' } }
  ]) {
    const h = harness(options)
    await assert.rejects(h.run())
    assert.equal(h.apiWrites.length, 1)
    assert.deepEqual(h.apiWrites[0].body, h.originalBody)
    assert.equal(h.record.checks.some((check) => check.name.includes('双端显式清空')), false)
  }
})

test('PB124 single-end immediate or queued write, missing exact warning and changed DB readback are failures', async () => {
  for (const options of [
    { singleWrites: true }, { delayedSingleWrite: true }, { missingWarning: true },
    { readResponse: (rows, count) => count === 4
      ? success([{ ...rows[0], version: rows[0].version + 1 }]) : undefined }
  ]) {
    const h = harness(options)
    await assert.rejects(h.run())
    assert.equal(h.apiWrites.length, 1)
    assert.deepEqual(rowBody(h.stored), h.originalBody)
    assert.equal(h.record.checks.some((check) => check.name.includes('单独清空任一')), false)
  }
})

test('PB124 missing explicit null request or readback is rejected and restored, never promoted', async () => {
  for (const options of [
    { mutatePayload: (body, count) => { if (count === 1) delete body.quietHoursEnd } },
    { mutatePayload: (body, count) => { if (count === 1) body.quietHoursStart = '' } },
    { readResponse: (rows, count) => {
      if (count === 8) { delete rows[0].quietHoursStart; return success(rows) }
    } },
    { readResponse: (rows, count) => count === 8
      ? success([{ ...rows[0], quietHoursEnd: '08:00' }]) : undefined }
  ]) {
    const h = harness(options)
    await assert.rejects(h.run())
    assert.equal(h.apiWrites.length, 1)
    assert.equal(h.record.checks.some((check) => check.name.includes('双端显式清空')), false)
  }
})

test('PB124 restoration failures stay visible with exact rule coordinates, including combined primary failure', async () => {
  for (const options of [
    { restoreFailure: true }, { restoreDrift: true }, { restoreResponse: success(false) },
    { restoreResponse: { code: 403, msg: 'not allowed' } }
  ]) {
    const h = harness(options)
    await assert.rejects(h.run())
    assert.ok(h.record.notes.some((note) => note.includes(id) && note.includes('恢复未验证')))
    assert.equal(h.record.checks.some((check) => check.name.includes('完整配置恢复')), false)
  }
  const h = harness({ response: { httpFailure: 403 }, restoreFailure: true })
  await assert.rejects(h.run(), (error) => {
    assert.ok(error instanceof AggregateError)
    assert.equal(error.errors.length, 2)
    assert.match(error.message, /HTTP 403.*restore failure: formal API restoration failed/)
    return true
  })
})

test('PB124 suite cleanup policy records its responsibility after failures too', async () => {
  const h = harness({ singleWrites: true })
  await assert.rejects(h.run({ cleanup: 'suite' }), /single-end clear issued/)
  assert.equal(h.apiWrites.length, 0)
  assert.ok(h.record.notes.some((note) => note.includes('suite需在finally清理')))
})

test('PB124 duplicate saves cannot pass as a single owned write', async () => {
  const h = harness({ duplicateWrites: true })
  await assert.rejects(h.run(), /exactly one after-sales write/)
  assert.equal(h.apiWrites.length, 1)
  assert.equal(h.record.checks.some((check) => check.name.includes('保留幂等模板')), false)
  assert.deepEqual(rowBody(h.stored), h.originalBody)
})

test('PB124 clicking clear may not autosave even if the following save is rejected and DB stays unchanged', async () => {
  const h = harness({ clearWrites: true })
  await assert.rejects(h.run(), /single-end clear issued a write request/)
  assert.equal(h.apiWrites.length, 1)
  assert.equal(h.record.checks.some((check) => check.name.includes('单独清空任一')), false)
  assert.deepEqual(rowBody(h.stored), h.originalBody)
})

test('PB124 request observation lasts through restoration reload and detaches even when an unexpected write occurs', async () => {
  const h = harness()
  const before = h.page.listenerCount('request')
  const reload = h.page.reload
  h.page.reload = async (args) => {
    await reload(args)
    if (h.reloadCount === 5) {
      const response = responseFor(h.originalBody)
      h.page.emit('request', response.request())
      h.page.emit('response', response)
      h.page.emit('requestfinished', response.request())
    }
  }
  await assert.rejects(h.run(), /restoration issued an unexpected browser write/)
  assert.equal(h.page.listenerCount('request'), before)
  assert.equal(h.record.checks.some((check) => check.name.includes('完整配置恢复')), false)
  assert.ok(h.record.notes.some((note) => note.includes('恢复未验证')))
})

test('PB124 response body must finish before API readback, refreshing, or restoration', async () => {
  let release, started
  const bodyGate = new Promise((resolve) => { release = resolve })
  const bodyStarted = new Promise((resolve) => { started = resolve })
  const h = harness({ response: { bodyGate, onBody: started } })
  const pending = h.run()
  await bodyStarted
  try {
    assert.equal(h.browserWrites.length, 1)
    assert.equal(h.events.filter(([kind]) => kind === 'api-read').length, 1)
    assert.equal(h.reloadCount, 0)
    assert.equal(h.apiWrites.length, 0)
  } finally {
    release()
  }
  assert.equal((await pending).restored, true)
})

test('PB124 browser list tenant, HTTP/business success and exact original object gate all UI writes', async () => {
  for (const options of [
    { browserRead: { tenant: '2' } },
    { browserRead: { tenant: '' } },
    { browserRead: { httpFailure: 403 } },
    { browserRead: { business: { code: 500, msg: 'unavailable' } } },
    { browserRows: [] },
    { browserRows: [{ id, ruleCode: 'SHARED' }] }
  ]) {
    const h = harness(options)
    await assert.rejects(h.run())
    assert.equal(h.apiWrites.length + h.browserWrites.length, 0)
    assert.equal(h.events.some(([kind]) => kind === 'edit'), false)
  }
  const h = harness()
  const baseGoto = h.page.goto
  h.page.goto = async (url) => {
    h.stored.quietHoursEnd = '09:00'
    await baseGoto(url)
  }
  await assert.rejects(h.run(), /browser\/API original rule mismatch/)
  assert.equal(h.apiWrites.length + h.browserWrites.length, 0)
})

test('PB124 helper source contains only scoped page/API work; no runner, status promotion, response injection or global execution', () => {
  const source = readFileSync(new URL('../fixtures/project-after-sales-reminder-browser.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source,
    /launchBrowser|createApiClient|newPage\s*\(|newContext\s*\(|\.route\s*\(|\.fulfill\s*\(|addInitScript/)
  assert.doesNotMatch(source, /api\.(?:postBusiness|deleteBusiness|request)\s*\(/)
  assert.doesNotMatch(source, /\/automation\/|\/worker\/|\/send|\/escalation|runLocalFixtureSql/)
  assert.doesNotMatch(source, /(?:acceptanceComplete|passCandidate):\s*true/)
  assert.match(source, /reminderExpectedKeys\(fixture, rule\)/)
  assert.match(source, /page\.off\('request', watchWrite\)/)
  assert.match(source, /\.el-date-editor \.clear-icon/)
  assert.doesNotMatch(source, /\.el-input__clear/)
})
