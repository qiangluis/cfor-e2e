import assert from 'node:assert/strict'
import { createDecipheriv } from 'node:crypto'
import { observePage } from '../lib/browser.mjs'
import { ENCRYPT_HEADER, REQ_KEY } from '../lib/crypto.mjs'
import {
  browserBusinessPayload,
  openAfterSalesSettingsTab,
  reloadAfterSalesSettingsTab
} from './project-after-sales-browser.mjs'
import {
  evaluationId,
  readEvaluationConfig
} from './project-after-sales-evaluation-closure.mjs'

const methodLabels = Object.freeze({
  RESOLUTION_CONFIRM: '解决确认', STAR: '五星评分',
  SINGLE: '单选', MULTIPLE: '多选', TEXT: '文本填写'
})
const field = (dialog, label) => dialog.locator('.el-form-item')
  .filter({ has: dialog.page().locator('.el-form-item__label', { hasText: new RegExp(`^${label}$`) }) })
const input = (dialog, label) => field(dialog, label).locator('input, textarea').first()
const selectedLabel = async (dialog, label) => (await field(dialog, label)
  .locator('.el-select__selection > .el-select__selected-item:not(.el-select__input-wrapper)')
  .innerText()).trim()
const dialogFor = (page) => page.locator('.el-dialog:visible').last()
const exactRow = async (page, code) => {
  const row = page.locator('.split-config-main .el-table__row').filter({
    has: page.locator('td .cell', { hasText: new RegExp(`^${code}$`) })
  })
  await row.waitFor({ state: 'visible' })
  assert.equal(await row.count(), 1, 'evaluation page must show one exact owned item')
  return row
}
const selectCategory = async (page, name) => {
  const category = page.locator('.split-config-aside .split-selector').filter({
    has: page.locator('span', { hasText: new RegExp(`^${name}$`) })
  })
  assert.equal(await category.count(), 1, 'evaluation page must show one owned category')
  await category.click()
}
export const selectEvaluationOption = async (page, formField, label) => {
  const select = formField.locator('.el-select')
  await select.click()
  const expanded = select.locator('input[role="combobox"][aria-expanded="true"]')
  await expanded.waitFor({ state: 'attached' })
  const controls = await expanded.getAttribute('aria-controls')
  assert.match(controls || '', /^[\w:-]+$/, 'evaluation select must identify its own listbox')
  const listboxSelector = `[role="listbox"][id=${JSON.stringify(controls)}]`
  const popup = page.locator('.el-popper.el-select__popper[aria-hidden="false"]:visible')
    .filter({ has: page.locator(listboxSelector) })
  await popup.waitFor({ state: 'visible' })
  const option = popup.locator(listboxSelector).getByRole('option', { name: label, exact: true })
  await option.waitFor({ state: 'visible' })
  await option.click({ trial: true })
  assert.equal(await option.count(), 1, 'evaluation option must resolve uniquely')
  await option.click()
  await select.locator('input[role="combobox"][aria-expanded="false"]').waitFor({ state: 'attached' })
  await popup.waitFor({ state: 'hidden' })
  const selected = select.locator(
    '.el-select__selection > .el-select__selected-item:not(.el-select__input-wrapper)')
  assert.equal((await selected.innerText()).trim(), label, 'evaluation selected label did not persist')
}
const booleanAttribute = (value, label) => {
  assert.ok(value === 'true' || value === 'false', `${label}: missing switch state`)
  return value === 'true'
}

export const readEvaluationSwitchState = async (wrapper, label) => {
  await wrapper.waitFor({ state: 'visible' })
  // Element Plus stores state on its hidden checkbox, not the surrounding div.
  const controls = await wrapper.evaluate((root) => {
    const selector = '[role="switch"], input[type="checkbox"]'
    const elements = root.matches(selector) ? [root] : [...root.querySelectorAll(selector)]
    return elements.map((element) => ({
      ariaChecked: element.getAttribute('aria-checked'),
      checked: element.tagName === 'INPUT' && element.type === 'checkbox' ? element.checked : null
    }))
  })
  assert.equal(controls.length, 1, `${label}: switch must resolve uniquely`)
  const { ariaChecked, checked } = controls[0]
  const states = []
  if (ariaChecked !== null) states.push(booleanAttribute(ariaChecked, label))
  if (checked !== null) {
    assert.equal(typeof checked, 'boolean', `${label}: invalid checkbox state`)
    states.push(checked)
  }
  assert.ok(states.length > 0, `${label}: missing switch state`)
  assert.equal(new Set(states).size, 1, `${label}: conflicting switch state`)
  return states[0]
}

export const readEvaluationItemForm = async (dialog) => ({
  categoryLabel: await selectedLabel(dialog, '项目分类'),
  itemCode: await input(dialog, '项目编码').inputValue(),
  itemName: await input(dialog, '评价项目').inputValue(),
  methodLabel: await selectedLabel(dialog, '评价方式'),
  optionsText: await input(dialog, '选项 / 量表').inputValue(),
  maxScore: await input(dialog, '最高分').inputValue(),
  required: await readEvaluationSwitchState(
    field(dialog, '必填与状态').locator('.el-switch').nth(0), 'required'),
  enabled: await readEvaluationSwitchState(
    field(dialog, '必填与状态').locator('.el-switch').nth(1), 'enabled')
})

export const assertEvaluationItemForm = (form, expected, categoryName) => {
  assert.deepEqual(form, {
    categoryLabel: categoryName, itemCode: expected.itemCode, itemName: expected.itemName,
    methodLabel: methodLabels[expected.evaluationType], optionsText: expected.options.join(' / '),
    maxScore: String(expected.maxScore), required: expected.required, enabled: true
  }, 'PB128 refreshed form does not match every saved field')
  return true
}

const requestPayload = (response) => {
  const request = response.request()
  if (request.headers()[ENCRYPT_HEADER.toLowerCase()] !== 'true') return request.postDataJSON()
  const decipher = createDecipheriv('aes-256-ecb',
    Buffer.from(process.env.CFOR_API_ENCRYPT_REQUEST_KEY || REQ_KEY, 'utf8'), null)
  const text = Buffer.concat([
    decipher.update(request.postData(), 'base64'), decipher.final()
  ]).toString('utf8')
  return JSON.parse(text)
}
export const isOwnedEvaluationItemResponse = (response, itemId) => {
  const url = new URL(response.url())
  return response.request().method() === 'PUT' &&
    url.pathname.endsWith('/after-sales/modeling/evaluation-item/update') &&
    url.searchParams.get('id') === evaluationId(itemId)
}
export const assertEvaluationItemWrite = (response, payload, itemId, expected) => {
  assert.equal(isOwnedEvaluationItemResponse(response, itemId), true, 'PB128 foreign browser write')
  assert.equal(evaluationId(payload?.categoryId), evaluationId(expected.categoryId), 'PB128 lossy/foreign category ID')
  assert.deepEqual(payload, { ...expected, categoryId: payload.categoryId },
    'PB128 browser request must contain the exact persisted item fields')
  return true
}
export const submitOwnedEvaluationItemDialog = async (page, dialog, itemId, expected) => {
  const [response] = await Promise.all([
    page.waitForResponse((response) => isOwnedEvaluationItemResponse(response, itemId)),
    dialog.getByRole('button', { name: '保存', exact: true }).click()
  ])
  assertEvaluationItemWrite(response, requestPayload(response), itemId, expected)
  await browserBusinessPayload(response)
  await dialog.waitFor({ state: 'hidden' })
  await observePage(page).flushResponses()
  return response
}
export const assertEvaluationItemReadback = (row, item, expected) => {
  assert.equal(evaluationId(row?.id), item.id)
  assert.equal(evaluationId(row.categoryId), evaluationId(expected.categoryId))
  assert.equal(row.itemCode, expected.itemCode)
  assert.equal(row.itemName, expected.itemName)
  assert.equal(row.evaluationType, expected.evaluationType)
  assert.ok(typeof row.optionsJson === 'string', 'missing persisted options')
  assert.deepEqual(JSON.parse(row.optionsJson), expected.options)
  assert.ok(typeof row.maxScore === 'number' || (typeof row.maxScore === 'string' &&
    /^\d+(?:\.\d+)?$/.test(row.maxScore)), 'invalid persisted maxScore')
  assert.equal(Number(row.maxScore), expected.maxScore)
  assert.equal(row.requiredFlag, expected.required)
  assert.equal(row.status, 'ENABLED')
  assert.equal(Number(row.sortNo), expected.sortNo)
  return true
}

export const savePb128EvaluationItem = async (
  page, api, fixture, item, expected, { capture = async () => {} } = {}
) => {
  assert.equal(fixture.caseId, 'PB128-001', 'PB128 cannot borrow another case fixture')
  const before = await readEvaluationConfig(api, fixture, item)
  const oldCategory = fixture.resources.find((resource) =>
    resource.type === 'EVALUATION_ITEM_CATEGORY' && resource.id === evaluationId(before.categoryId))
  const newCategory = fixture.resources.find((resource) =>
    resource.type === 'EVALUATION_ITEM_CATEGORY' && resource.id === evaluationId(expected.categoryId))
  assert.ok(oldCategory && newCategory, 'PB128 requires owned source and destination categories')
  assert.equal(expected.itemCode, item.body.itemCode, 'PB128 cannot rename stable code in page test')
  await openAfterSalesSettingsTab(page, '评价项目')
  await selectCategory(page, oldCategory.body.categoryName)
  const row = await exactRow(page, item.body.itemCode)
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  const dialog = dialogFor(page)
  await selectEvaluationOption(page, field(dialog, '项目分类'), newCategory.body.categoryName)
  await input(dialog, '评价项目').fill(expected.itemName)
  await selectEvaluationOption(page, field(dialog, '评价方式'), methodLabels[expected.evaluationType])
  await input(dialog, '选项 / 量表').fill(expected.options.join(' / '))
  await input(dialog, '最高分').fill(String(expected.maxScore))
  const required = field(dialog, '必填与状态').locator('.el-switch').nth(0)
  if (await readEvaluationSwitchState(required, 'required') !== expected.required) {
    await required.click()
  }
  await submitOwnedEvaluationItemDialog(page, dialog, item.id, expected)
  const saved = await readEvaluationConfig(api, fixture, item)
  assertEvaluationItemReadback(saved, item, expected)
  await capture('pb128-evaluation-item-saved')
  await reloadAfterSalesSettingsTab(page, '评价项目')
  await selectCategory(page, newCategory.body.categoryName)
  const refreshedRow = await exactRow(page, item.body.itemCode)
  await refreshedRow.getByRole('button', { name: '编辑', exact: true }).click()
  const refreshedDialog = dialogFor(page)
  const form = await readEvaluationItemForm(refreshedDialog)
  assertEvaluationItemForm(form, expected, newCategory.body.categoryName)
  const persisted = await readEvaluationConfig(api, fixture, item)
  assertEvaluationItemReadback(persisted, item, expected)
  assert.deepEqual(persisted, saved, 'PB128 server readback drifted across page reload')
  await capture('pb128-evaluation-item-refreshed')
  await refreshedDialog.getByRole('button', { name: '取消', exact: true }).click()
  item.body = structuredClone(expected)
  return { form, saved: structuredClone(saved), persisted: structuredClone(persisted) }
}

export const readEvaluationTemplateRows = async (page) => {
  const rows = page.locator('.template-layout .split-config-table .el-table__row')
  const result = []
  for (let index = 0; index < await rows.count(); index++) {
    const row = rows.nth(index)
    result.push({
      name: (await row.locator('td').nth(0).innerText()).trim(),
      methodLabel: (await row.locator('td').nth(2)
        .locator('.el-select__selected-item:not(.el-select__input-wrapper)').innerText()).trim(),
      score: await row.locator('td').nth(3).locator('input').inputValue(),
      required: await readEvaluationSwitchState(
        row.locator('td').nth(4).locator('.el-switch'), 'template required'),
      sortNo: await row.locator('td').nth(5).locator('input').inputValue()
    })
  }
  return result
}
export const assertEvaluationTemplateRows = (rows, snapshot) => {
  assert.ok(Array.isArray(snapshot?.items) && snapshot.items.length > 0, 'template requires nonempty snapshot')
  for (const item of snapshot.items) {
    assert.ok(typeof item.itemNameSnapshot === 'string' && item.itemNameSnapshot.length > 0)
    assert.ok(Object.hasOwn(methodLabels, item.evaluationTypeSnapshot), 'unknown snapshot type')
    assert.equal(typeof item.requiredFlag, 'boolean')
    assert.ok(Number.isFinite(item.score) && item.score >= 0)
    assert.ok(Number.isSafeInteger(item.sortNo) && item.sortNo >= 0)
  }
  assert.deepEqual(rows, snapshot.items.map((item) => ({
    name: item.itemNameSnapshot, methodLabel: methodLabels[item.evaluationTypeSnapshot],
    score: String(item.score), required: item.requiredFlag, sortNo: String(item.sortNo)
  })), 'PB129 page must display frozen names, types, order, scores and required flags')
  return true
}
export const verifyPb129TemplatePage = async (page, fixture, template, { capture = async () => {} } = {}) => {
  assert.equal(fixture.caseId, 'PB129-001', 'PB129 cannot borrow another case fixture')
  await openAfterSalesSettingsTab(page, '评价模板')
  // V1 and V2 intentionally have the same name; match the displayed version as well.
  const selected = page.locator('.template-selector')
    .filter({ has: page.locator('span', { hasText: new RegExp(`^${template.body.templateName}$`) }) })
    .filter({ has: page.locator('small', { hasText: `V${template.body.versionNo} ·` }) })
  assert.equal(await selected.count(), 1, 'PB129 template version must resolve uniquely')
  await selected.click()
  assertEvaluationTemplateRows(await readEvaluationTemplateRows(page), template.snapshot)
  await reloadAfterSalesSettingsTab(page, '评价模板')
  const refreshed = page.locator('.template-selector')
    .filter({ has: page.locator('span', { hasText: new RegExp(`^${template.body.templateName}$`) }) })
    .filter({ has: page.locator('small', { hasText: `V${template.body.versionNo} ·` }) })
  assert.equal(await refreshed.count(), 1, 'PB129 refreshed template version must resolve uniquely')
  await refreshed.click()
  const rows = await readEvaluationTemplateRows(page)
  assertEvaluationTemplateRows(rows, template.snapshot)
  await observePage(page).flushResponses()
  await capture('pb129-template-frozen-refreshed')
  return rows
}
