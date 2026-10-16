import assert from 'node:assert/strict'
import { createDecipheriv } from 'node:crypto'
import { config } from '../config/index.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { observePage } from '../lib/browser.mjs'
import { ENCRYPT_HEADER, REQ_KEY } from '../lib/crypto.mjs'
import { assertLocalWriteSafety } from '../lib/db.mjs'
import { resourceUrl } from '../lib/redact.mjs'
import {
  browserBusinessPayload,
  openAfterSalesSettingsTab,
  reloadAfterSalesSettingsTab
} from './project-after-sales-browser.mjs'
import {
  assertReminderLocalTarget,
  reminderExpectedKeys
} from './project-after-sales-reminder-closure.mjs'

const listPath = '/after-sales/modeling/reminder-rule/list'
const updatePath = '/after-sales/modeling/reminder-rule/update'
const pairWarning = '请同时设置免打扰开始和结束时间，或同时清空'
const scalarFields = [
  'ruleCode', 'ruleName', 'reminderScene', 'firstDelayMinutes', 'repeatEnabled',
  'repeatIntervalMinutes', 'maxTimes', 'stopCondition', 'messageTemplate',
  'idempotencyKeyTemplate', 'quietHoursStart', 'quietHoursEnd', 'remark'
]
const arrayFields = ['applicableStatuses', 'channels', 'receiverTypes']
const exact = (value) => new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
const ruleId = (value) => {
  assert.ok(typeof value === 'string' || typeof value === 'number', 'PB124 invalid rule ID')
  assert.match(String(value), /^[1-9]\d*$/, 'PB124 requires a positive rule ID')
  assert.ok(typeof value !== 'number' || Number.isSafeInteger(value), 'PB124 lossy rule ID')
  assert.ok(BigInt(value) <= 9223372036854775807n, 'PB124 rule ID exceeds Long')
  return String(value)
}
const ownedRule = (fixture, rule) => {
  // Reuse the closure fixture's private ownership proof, not a forgeable code prefix.
  reminderExpectedKeys(fixture, rule)
  assert.equal(rule.body.ruleCode, `${fixture.marker}-RULE`, 'PB124 foreign rule code')
  return ruleId(rule.id)
}
const field = (dialog, label) => dialog.locator('.el-form-item').filter({
  has: dialog.page().locator('.el-form-item__label', { hasText: exact(label) })
})
const input = (dialog, label) => field(dialog, label).locator('input').first()
const dialogFor = (page) => page.locator('.el-dialog:visible').last()
const data = (response, label) => assertBusinessSuccess(response, label).data

const bodyFromRow = (row) => {
  const body = {}
  for (const key of scalarFields) {
    assert.ok(Object.hasOwn(row, key), `PB124 missing persisted ${key}`)
    body[key] = row[key]
  }
  for (const key of arrayFields) {
    assert.equal(typeof row[`${key}Json`], 'string', `PB124 missing persisted ${key}Json`)
    body[key] = JSON.parse(row[`${key}Json`])
    assert.ok(Array.isArray(body[key]), `PB124 invalid persisted ${key}`)
  }
  return body
}

const ownedRow = (rows, fixture, rule) => {
  const id = ownedRule(fixture, rule)
  assert.ok(Array.isArray(rows), 'PB124 missing reminder rule list')
  const matches = rows.filter((row) =>
    String(row?.id) === id || row?.ruleCode === rule.body.ruleCode)
  assert.equal(matches.length, 1, 'PB124 owned rule must be uniquely visible')
  const row = matches[0]
  assert.equal(ruleId(row.id), id, 'PB124 foreign readback ID')
  assert.equal(row.ruleCode, rule.body.ruleCode, 'PB124 foreign readback code')
  if (Object.hasOwn(row, 'tenantId')) assert.equal(String(row.tenantId), '1', 'PB124 foreign tenant')
  return structuredClone(row)
}
const readOwnedRule = async (api, fixture, rule) =>
  ownedRow(data(await api.getBusiness(listPath), 'PB124 browser rule readback'), fixture, rule)

export const readReminderRuleForm = async (dialog) => ({
  ruleCode: await input(dialog, '模型编码').inputValue(),
  ruleName: await input(dialog, '模型名称').inputValue(),
  quietHoursStart: await input(dialog, '免打扰开始').inputValue(),
  quietHoursEnd: await input(dialog, '免打扰结束').inputValue()
})

export const assertReminderRuleForm = (form, expected) => {
  assert.deepEqual(form, {
    ruleCode: expected.ruleCode, ruleName: expected.ruleName,
    quietHoursStart: expected.quietHoursStart === null ? '' : expected.quietHoursStart,
    quietHoursEnd: expected.quietHoursEnd === null ? '' : expected.quietHoursEnd
  }, 'PB124 exact reminder form mismatch')
  return true
}

export const assertReminderDelayForm = (form, minutes) => {
  const units = { '分钟': 1, '小时': 60, '天': 1440 }
  assert.ok(Object.hasOwn(units, form.unit), 'PB124 invalid displayed reminder time unit')
  assert.match(form.value, /^\d+$/, 'PB124 invalid displayed reminder time value')
  const value = Number(form.value)
  assert.ok(Number.isSafeInteger(value), 'PB124 unsafe displayed reminder time value')
  assert.ok(Number.isSafeInteger(minutes) && minutes >= 0, 'PB124 invalid API reminder minutes')
  assert.equal(value * units[form.unit], minutes, 'PB124 displayed reminder time differs from API minutes')
  return true
}

const assertDisplayedDelay = async (dialog, expected) => {
  assert.equal(expected.reminderScene, 'ASSET_SERVICE_DUE', 'PB124 browser fixture requires asset reminder')
  const control = field(dialog, '到期前提醒')
  const form = {
    value: await control.locator('input').first().inputValue(),
    unit: (await control.locator('.el-select__selected-item:not(.el-select__input-wrapper)').innerText()).trim()
  }
  assertReminderDelayForm(form, expected.firstDelayMinutes)
  return form
}

const requestBody = (request) => {
  if (request.headers()[ENCRYPT_HEADER.toLowerCase()] !== 'true') return request.postDataJSON()
  const decipher = createDecipheriv('aes-256-ecb',
    Buffer.from(process.env.CFOR_API_ENCRYPT_REQUEST_KEY || REQ_KEY, 'utf8'), null)
  return JSON.parse(Buffer.concat([
    decipher.update(request.postData(), 'base64'), decipher.final()
  ]).toString('utf8'))
}
const updateUrl = (settings) => new URL(`/admin-api${updatePath}`, settings.apiBase)
const isUpdateResponse = (response, settings) => {
  const url = new URL(response.url())
  const target = updateUrl(settings)
  return response.request().method() === 'PUT' &&
    url.origin === target.origin && url.pathname === target.pathname
}

export const assertReminderRuleWrite = (response, expectedId, expected, settings = config) => {
  assert.equal(isUpdateResponse(response, settings), true, 'PB124 wrong update endpoint')
  const url = new URL(response.url())
  assert.deepEqual([...url.searchParams.keys()], ['id'], 'PB124 ambiguous update query')
  assert.equal(url.searchParams.get('id'), ruleId(expectedId), 'PB124 foreign browser write ID')
  assert.equal(response.request().headers()['tenant-id'], '1', 'PB124 wrong browser tenant')
  const payload = requestBody(response.request())
  assert.deepEqual(payload, expected, 'PB124 exact browser request fields mismatch')
  return { payload: structuredClone(payload) }
}

const openOwnedDialog = async (page, expected) => {
  await page.getByPlaceholder('编码 / 名称 / 适用范围').fill(expected.ruleCode)
  const row = page.locator('.reminder-table .el-table__row').filter({
    has: page.locator('td .cell', { hasText: exact(expected.ruleCode) })
  })
  await row.waitFor({ state: 'visible' })
  assert.equal(await row.count(), 1, 'PB124 page must show one exact owned rule')
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  const dialog = dialogFor(page)
  await dialog.waitFor({ state: 'visible' })
  assertReminderRuleForm(await readReminderRuleForm(dialog), expected)
  await assertDisplayedDelay(dialog, expected)
  return dialog
}

const verifyArrowPicker = async (page, dialog, expected, capture) => {
  const control = input(dialog, '免打扰开始')
  await control.click()
  const panel = page.locator('.el-time-panel:visible')
  await panel.waitFor({ state: 'visible' })
  assert.equal(await panel.count(), 1, 'PB124 time picker panel must be unique')
  const columns = panel.locator('.el-time-spinner__wrapper.is-arrow')
  assert.equal(await columns.count(), 2, 'PB124 requires separate arrow hour/minute columns')
  assert.equal(await panel.locator('.el-scrollbar').count(), 0, 'PB124 picker unexpectedly uses scrollbars')
  const minute = columns.nth(1)
  await minute.hover()
  await minute.locator('.arrow-down').click()
  assert.equal(await control.inputValue(), '22:01', 'PB124 picker cannot select an arbitrary minute')
  await minute.locator('.arrow-up').click()
  assert.equal(await control.inputValue(), expected.quietHoursStart, 'PB124 picker did not return to original time')
  await capture('pb124-reminder-arrow-picker')
  await panel.locator('.el-time-panel__btn.cancel').click()
  await panel.waitFor({ state: 'hidden' })
  assertReminderRuleForm(await readReminderRuleForm(dialog), expected)
}

const clearTime = async (dialog, label) => {
  const control = input(dialog, label)
  await control.hover()
  const clear = field(dialog, label).locator('.el-date-editor .clear-icon')
  await clear.waitFor({ state: 'visible' })
  assert.equal(await clear.count(), 1, 'PB124 time picker clear control must be unique')
  await clear.click()
  assert.equal(await control.inputValue(), '', 'PB124 time picker did not clear')
}

const assertOneWrite = (writes, before, response) => {
  assert.equal(writes.length - before, 1, 'PB124 save must issue exactly one after-sales write')
  assert.equal(writes[before], response.request(), 'PB124 save issued a different after-sales write')
}

const saveDialog = async (page, dialog, id, expected, writes, settings) => {
  const before = writes.length
  const [response] = await Promise.all([
    page.waitForResponse((item) => isUpdateResponse(item, settings)),
    dialog.getByRole('button', { name: '保存', exact: true }).click()
  ])
  const observed = assertReminderRuleWrite(response, id, expected, settings)
  assert.equal(await browserBusinessPayload(response), true, 'PB124 save did not return true')
  await dialog.waitFor({ state: 'hidden' })
  await observePage(page).flushResponses()
  assertOneWrite(writes, before, response)
  return observed
}

const readAndRefresh = async (page, api, fixture, rule, expected, capture, tag) => {
  const saved = await readOwnedRule(api, fixture, rule)
  assert.equal(saved.status, 'ENABLED', 'PB124 page changed rule status')
  assert.deepEqual(bodyFromRow(saved), expected, 'PB124 saved API fields mismatch')
  await capture(`${tag}-saved`)
  await reloadAfterSalesSettingsTab(page, '提醒规则')
  const dialog = await openOwnedDialog(page, expected)
  const form = await readReminderRuleForm(dialog)
  const refreshed = await readOwnedRule(api, fixture, rule)
  assert.deepEqual(refreshed, saved, 'PB124 server rule drifted across page refresh')
  await capture(`${tag}-refreshed`)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  return { saved, refreshed, form }
}

export const verifyReminderRuleQuietHoursInBrowser = async ({
  page, api, fixture, rule, caseRecord, renamedName = `${fixture?.marker}-UI`,
  cleanup = 'restore', capture = async () => {}, dependencies = {}
}) => {
  const settings = dependencies.config || config
  const id = ownedRule(fixture, rule)
  assertReminderLocalTarget(settings, dependencies.writeEnabled ?? process.env.CFOR_E2E_WRITE_FIXTURES)
  assert.ok(['restore', 'suite'].includes(cleanup), 'PB124 requires an explicit cleanup policy')
  assert.ok(Array.isArray(caseRecord?.checks) && Array.isArray(caseRecord?.notes), 'PB124 missing case record')
  if (caseRecord.caseId) assert.equal(caseRecord.caseId, 'PB124-001', 'PB124 foreign case record')
  assert.equal(new URL(page.url()).origin, new URL(settings.webBase).origin, 'PB124 foreign browser page')
  assert.ok(typeof renamedName === 'string' && renamedName.startsWith(`${fixture.marker}-`) &&
    renamedName !== rule.body.ruleName, 'PB124 requires a dedicated changed name')
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
  const original = await readOwnedRule(api, fixture, rule)
  const originalBody = bodyFromRow(original)
  assert.deepEqual(originalBody, rule.body, 'PB124 original rule differs from the owned fixture')
  assert.equal(original.status, 'ENABLED', 'PB124 requires an enabled owned rule')
  for (const key of ['quietHoursStart', 'quietHoursEnd']) {
    assert.match(originalBody[key], /^(?:[01]\d|2[0-3]):[0-5]\d$/, 'PB124 requires HH:mm quiet hours')
  }
  assert.ok(originalBody.quietHoursStart > originalBody.quietHoursEnd,
    'PB124 requires original cross-midnight quiet hours')
  const writes = []
  const watchPageError = (error) => {
    caseRecord.reminderBrowserPageErrors ||= []
    caseRecord.reminderBrowserPageErrors.push({
      message: error.message,
      stack: String(error.stack || '').replace(/https?:\/\/[^\s)]+/g, resourceUrl)
    })
  }
  const watchWrite = (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) &&
        /\/(?:admin|app)-api\/after-sales\//.test(request.url())) writes.push(request)
  }
  observePage(page, caseRecord)
  page.on('request', watchWrite)
  page.on('pageerror', watchPageError)
  let attempted = false, result, failure
  try {
    const [listResponse] = await Promise.all([
      page.waitForResponse((response) => {
        const url = new URL(response.url())
        return response.request().method() === 'GET' &&
          url.origin === new URL(settings.apiBase).origin && url.pathname === `/admin-api${listPath}`
      }),
      openAfterSalesSettingsTab(page, '提醒规则')
    ])
    assert.equal(listResponse.request().headers()['tenant-id'], '1', 'PB124 wrong browser read tenant')
    const browserRow = ownedRow(await browserBusinessPayload(listResponse), fixture, rule)
    assert.deepEqual(bodyFromRow(browserRow), originalBody, 'PB124 browser/API original rule mismatch')
    assert.equal(browserRow.status, original.status, 'PB124 browser/API original status mismatch')
    const initial = await openOwnedDialog(page, originalBody)
    await verifyArrowPicker(page, initial, originalBody, capture)
    assert.equal(writes.length, 0, 'PB124 time picker interaction issued an unexpected write')
    caseRecord.checks.push({ name: 'PB124 时间面板箭头逐分钟选择、取消不写库，显示时间单位与API一致',
      passed: true, details: `${id}; 22:00 -> 22:01 -> 22:00; ${originalBody.firstDelayMinutes} minutes` })
    await input(initial, '模型名称').fill(renamedName)
    attempted = true
    const renamed = await saveDialog(page, initial, id, {
      ...originalBody, ruleName: renamedName
    }, writes, settings)
    const preserved = await readAndRefresh(page, api, fixture, rule,
      renamed.payload, capture, 'pb124-reminder-name')
    caseRecord.checks.push({ name: 'PB124 页面改名称保留幂等模板及跨午夜免打扰：完整请求/API/刷新表单',
      passed: true, details: `${id}/${originalBody.quietHoursStart}/${originalBody.quietHoursEnd}` })

    const warning = page.locator('.el-message--warning .el-message__content')
      .filter({ hasText: exact(pairWarning) })
    const rejected = []
    for (const [label, key] of [
      ['免打扰开始', 'quietHoursStart'], ['免打扰结束', 'quietHoursEnd']
    ]) {
      const before = writes.length
      const dialog = await openOwnedDialog(page, renamed.payload)
      await clearTime(dialog, label)
      assertReminderRuleForm(await readReminderRuleForm(dialog), { ...renamed.payload, [key]: null })
      await warning.waitFor({ state: 'hidden' })
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await warning.waitFor({ state: 'visible' })
      await dialog.waitFor({ state: 'visible' })
      assertReminderRuleForm(await readReminderRuleForm(dialog), { ...renamed.payload, [key]: null })
      await observePage(page).flushResponses({ quietMs: 250 })
      assert.equal(writes.length, before, 'PB124 single-end clear issued a write request')
      const unchanged = await readOwnedRule(api, fixture, rule)
      assert.deepEqual(unchanged, preserved.saved, 'PB124 rejected clear changed server data')
      await capture(`pb124-reminder-${key}-rejected`)
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await reloadAfterSalesSettingsTab(page, '提醒规则')
      const refreshed = await openOwnedDialog(page, renamed.payload)
      assert.deepEqual(await readOwnedRule(api, fixture, rule), preserved.saved,
        'PB124 rejected clear changed data across refresh')
      await refreshed.getByRole('button', { name: '取消', exact: true }).click()
      assert.equal(writes.length, before, 'PB124 rejected clear wrote during refresh')
      rejected.push({ field: key, writeCount: 0, unchanged })
    }
    caseRecord.checks.push({ name: 'PB124 单独清空任一免打扰端：精确提示、零写请求、API/UI不变',
      passed: true, details: `${id}; start/end tested separately` })

    const clearing = await openOwnedDialog(page, renamed.payload)
    await clearTime(clearing, '免打扰开始')
    await clearTime(clearing, '免打扰结束')
    assertReminderRuleForm(await readReminderRuleForm(clearing), {
      ...renamed.payload, quietHoursStart: null, quietHoursEnd: null
    })
    const clearedWrite = await saveDialog(page, clearing, id, {
      ...renamed.payload, quietHoursStart: null, quietHoursEnd: null
    }, writes, settings)
    const cleared = await readAndRefresh(page, api, fixture, rule,
      clearedWrite.payload, capture, 'pb124-reminder-cleared')
    assert.equal(writes.length, 2, 'PB124 browser flow issued unexpected after-sales writes')
    caseRecord.checks.push({ name: 'PB124 双端显式清空：请求两个null、API回读null、刷新表单为空',
      passed: true, details: id })
    result = {
      browserQuietHoursVerified: true, partial: true, acceptanceComplete: false, passCandidate: false,
      ruleId: id, originalBody, preserved, rejected, cleared,
      requests: [renamed.payload, clearedWrite.payload],
      cleanupRequired: cleanup === 'suite', restored: false
    }
  } catch (error) {
    failure = error
  } finally {
    const beforeCleanup = writes.length
    if (attempted && cleanup === 'restore') {
      try {
        await observePage(page).flushResponses()
        await readOwnedRule(api, fixture, rule)
        assert.equal(data(await api.putBusiness(`${updatePath}?id=${id}`,
          structuredClone(originalBody)), 'PB124 restore dedicated rule'), true)
        const restored = await readOwnedRule(api, fixture, rule)
        assert.deepEqual(bodyFromRow(restored), originalBody, 'PB124 original rule restoration failed')
        assert.equal(restored.status, original.status, 'PB124 restoration changed status')
        await reloadAfterSalesSettingsTab(page, '提醒规则')
        const dialog = await openOwnedDialog(page, originalBody)
        await capture('pb124-reminder-restored')
        await dialog.getByRole('button', { name: '取消', exact: true }).click()
        await observePage(page).flushResponses()
        assert.equal(writes.length, beforeCleanup, 'PB124 restoration issued an unexpected browser write')
        caseRecord.checks.push({ name: 'PB124 专属规则完整配置恢复与API/UI回读', passed: true, details: id })
        if (result) result.restored = true
      } catch (error) {
        caseRecord.notes.push(`PB124 专属规则 ${id}/${originalBody.ruleCode} 恢复未验证：${error.message}`)
        failure = failure ? new AggregateError([failure, error],
          `PB124 browser failure: ${failure.message}; restore failure: ${error.message}`) : error
      }
    } else if (attempted) {
      caseRecord.notes.push(`PB124 suite负责规则 ${id}/${originalBody.ruleCode} 的正式API恢复或限定ID停用；
        当前两端可能已清空，不能直接使用旧cleanupReminderClosure的22:00/08:00前置。
        原rule.body未改写；suite需在finally清理，即使helper抛错。`)
    }
    page.off('request', watchWrite)
    page.off('pageerror', watchPageError)
  }
  if (failure) throw failure
  caseRecord.notes.push('PB124 本helper只补免打扰页面保存与刷新证据，不验证消费/通知待办/展示审计/升级，不提升整例状态。')
  return result
}
