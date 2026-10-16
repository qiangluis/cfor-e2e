import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { encryptRequest, ENCRYPT_HEADER } from '../lib/crypto.mjs'
import {
  assertEvaluationItemForm,
  assertEvaluationItemReadback,
  assertEvaluationItemWrite,
  assertEvaluationTemplateRows,
  isOwnedEvaluationItemResponse,
  readEvaluationItemForm,
  readEvaluationSwitchState,
  readEvaluationTemplateRows,
  selectEvaluationOption,
  submitOwnedEvaluationItemDialog
} from '../fixtures/project-after-sales-evaluation-browser.mjs'

const expected = {
  categoryId: '2109000000000000001', itemCode: 'PB128-ITEM',
  itemName: 'PB128-PERSISTED', evaluationType: 'MULTIPLE',
  options: ['A', 'B', 'C'], maxScore: 70, required: true, sortNo: 0
}
const itemId = '2109000000000000002'
const makeResponse = (overrides = {}) => {
  const request = {
    method: () => 'PUT', headers: () => ({}),
    postDataJSON: () => structuredClone(expected),
    ...overrides.request
  }
  return {
    url: () => `http://localhost:48083/admin-api/after-sales/modeling/evaluation-item/update?id=${itemId}`,
    request: () => request, ok: () => true, status: () => 200, headers: () => ({}),
    text: async () => '{"code":0,"msg":"","data":true}', ...overrides.response
  }
}
const form = {
  categoryLabel: 'PB128-CATEGORY-B', itemCode: expected.itemCode, itemName: expected.itemName,
  methodLabel: '多选', optionsText: 'A / B / C', maxScore: '70', required: true, enabled: true
}
const stored = {
  id: itemId, categoryId: expected.categoryId, itemCode: expected.itemCode, itemName: expected.itemName,
  evaluationType: expected.evaluationType, optionsJson: JSON.stringify(expected.options),
  maxScore: 70, requiredFlag: true, sortNo: 0, status: 'ENABLED'
}
const snapshot = {
  items: [
    { itemNameSnapshot: 'RESOLVED', evaluationTypeSnapshot: 'RESOLUTION_CONFIRM',
      score: 0, requiredFlag: true, sortNo: 1 },
    { itemNameSnapshot: 'FROZEN-CHOICE', evaluationTypeSnapshot: 'SINGLE',
      score: 40, requiredFlag: false, sortNo: 2 },
    { itemNameSnapshot: 'FROZEN-STAR', evaluationTypeSnapshot: 'STAR',
      score: 60, requiredFlag: true, sortNo: 3 }
  ]
}
const templateRows = [
  { name: 'RESOLVED', methodLabel: '解决确认', score: '0', required: true, sortNo: '1' },
  { name: 'FROZEN-CHOICE', methodLabel: '单选', score: '40', required: false, sortNo: '2' },
  { name: 'FROZEN-STAR', methodLabel: '五星评分', score: '60', required: true, sortNo: '3' }
]

const switchNode = ({
  tagName = 'INPUT', type = 'checkbox', role = 'switch', ariaChecked = null, checked = false
} = {}) => ({
  tagName, type, checked,
  matches: (selector) => {
    assert.equal(selector, '[role="switch"], input[type="checkbox"]')
    return role === 'switch' || (tagName === 'INPUT' && type === 'checkbox')
  },
  getAttribute: (name) => {
    assert.equal(name, 'aria-checked')
    return ariaChecked
  },
  querySelectorAll: () => []
})
const switchLocator = (controls, root = {
  matches: () => false,
  querySelectorAll: (selector) => {
    assert.equal(selector, '[role="switch"], input[type="checkbox"]')
    return controls
  }
}) => ({
  waitFor: async ({ state }) => assert.equal(state, 'visible'),
  evaluate: async (read) => read(root)
})
const checkboxSwitch = (checked) =>
  switchLocator([switchNode({ checked, ariaChecked: String(checked) })])

test('PB128 reads selected labels, exact input fields and both actual switch states', async () => {
  const labels = {
    项目分类: { selected: form.categoryLabel },
    项目编码: { value: form.itemCode }, 评价项目: { value: form.itemName },
    评价方式: { selected: form.methodLabel }, '选项 / 量表': { value: form.optionsText },
    最高分: { value: form.maxScore }, 必填与状态: { switches: [true, true] }
  }
  const page = {
    locator: (selector, options) => {
      assert.equal(selector, '.el-form-item__label')
      return { label: Object.keys(labels).find((label) => options.hasText.test(label)) }
    }
  }
  const dialog = {
    page: () => page,
    locator: (selector) => {
      assert.equal(selector, '.el-form-item')
      return {
        filter: ({ has }) => ({
          locator: (selector) => {
            const data = labels[has.label]
            if (selector === 'input, textarea') return { first: () => ({
              inputValue: async () => data.value
            }) }
            if (selector === '.el-switch') return { nth: (index) =>
              checkboxSwitch(data.switches[index]) }
            assert.equal(selector,
              '.el-select__selection > .el-select__selected-item:not(.el-select__input-wrapper)')
            return { innerText: async () => data.selected }
          }
        })
      }
    }
  }
  assert.deepEqual(await readEvaluationItemForm(dialog), form)
  assert.equal(assertEvaluationItemForm(form, expected, form.categoryLabel), true)
})

test('PB128 refuses wrong category/type/options/order/required/score even when row text contains the right words', () => {
  for (const change of [
    { categoryLabel: '' }, { categoryLabel: 'SHARED' }, { itemCode: 'FOREIGN' },
    { itemName: 'OLD' }, { methodLabel: '' }, { methodLabel: '单选' },
    { optionsText: 'B / A / C' }, { maxScore: '40' }, { required: false }, { enabled: false }
  ]) assert.throws(() => assertEvaluationItemForm({ ...form, ...change }, expected, form.categoryLabel))
  for (const change of [
    { id: '999' }, { categoryId: '999' }, { itemCode: 'FOREIGN' }, { itemName: 'OLD' },
    { evaluationType: 'SINGLE' }, { optionsJson: '["B","A","C"]' },
    { optionsJson: null }, { maxScore: null }, { requiredFlag: false }, { status: 'DISABLED' }
  ]) assert.throws(() => assertEvaluationItemReadback({ ...stored, ...change }, { id: itemId }, expected))
})

test('PB128 response identity is specific to PUT, exact path and the lossless item ID', () => {
  assert.equal(isOwnedEvaluationItemResponse(makeResponse(), itemId), true)
  for (const response of [
    makeResponse({ request: { method: () => 'POST' } }),
    makeResponse({ response: { url: () => 'http://localhost/after-sales/modeling/evaluation-item/update?id=999' } }),
    makeResponse({ response: { url: () => `http://localhost/after-sales/modeling/evaluation-template/update?id=${itemId}` } }),
    makeResponse({ response: { url: () => `http://localhost/after-sales/modeling/evaluation-item/update?id=${Number(itemId)}` } })
  ]) assert.equal(isOwnedEvaluationItemResponse(response, itemId), false)
  assert.equal(assertEvaluationItemWrite(makeResponse(), expected, itemId, expected), true)
  for (const payload of [
    { ...expected, categoryId: Number(expected.categoryId) },
    { ...expected, categoryId: '999' }, { ...expected, options: ['C', 'B', 'A'] },
    { ...expected, required: false }, { ...expected, maxScore: 40 }
  ]) assert.throws(() => assertEvaluationItemWrite(makeResponse(), payload, itemId, expected))
})

test('PB128 save awaits response body and dialog closure before accepting the write', async () => {
  const page = new EventEmitter()
  const events = []
  let resolveBody
  const body = new Promise((resolve) => { resolveBody = resolve })
  const response = makeResponse({ response: {
    text: async () => { events.push('body'); return body }
  } })
  page.waitForResponse = async (predicate) => {
    events.push('wait-response')
    assert.equal(predicate(response), true)
    return response
  }
  const dialog = {
    getByRole: () => ({ click: async () => events.push('click-save') }),
    waitFor: async ({ state }) => {
      assert.equal(state, 'hidden')
      events.push('dialog-hidden')
    }
  }
  let finished = false
  const saving = submitOwnedEvaluationItemDialog(page, dialog, itemId, expected)
    .then(() => { finished = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(finished, false)
  assert.deepEqual(events, ['wait-response', 'click-save', 'body'])
  resolveBody('{"code":0,"msg":"","data":true}')
  await saving
  assert.deepEqual(events, ['wait-response', 'click-save', 'body', 'dialog-hidden'])
})

test('PB128 save propagates HTTP/business/body-read/dialog/pending failures instead of declaring persistence', async () => {
  for (const response of [
    makeResponse({ response: { ok: () => false, status: () => 401 } }),
    makeResponse({ response: { text: async () => '{"code":500,"msg":"save failed"}' } }),
    makeResponse({ response: { text: async () => { throw new Error('body pending failed') } } })
  ]) {
    const page = new EventEmitter()
    page.waitForResponse = async () => response
    let hidden = false
    const dialog = { getByRole: () => ({ click: async () => {} }),
      waitFor: async () => { hidden = true } }
    await assert.rejects(submitOwnedEvaluationItemDialog(page, dialog, itemId, expected))
    assert.equal(hidden, false)
  }
  for (const stage of ['pending', 'dialog']) {
    const page = new EventEmitter()
    page.waitForResponse = async () => {
      if (stage === 'pending') throw new Error('response pending failed')
      return makeResponse()
    }
    const dialog = { getByRole: () => ({ click: async () => {} }),
      waitFor: async () => { throw new Error('dialog did not close') } }
    await assert.rejects(submitOwnedEvaluationItemDialog(page, dialog, itemId, expected),
      stage === 'pending' ? /pending failed/ : /dialog did not close/)
  }
})

test('PB128 encrypted browser payloads still require the exact saved ownership and fields', async () => {
  const page = new EventEmitter()
  const encrypted = encryptRequest(expected)
  const response = makeResponse({ request: {
    headers: () => ({ [ENCRYPT_HEADER.toLowerCase()]: 'true' }), postData: () => encrypted
  } })
  page.waitForResponse = async () => response
  const dialog = { getByRole: () => ({ click: async () => {} }), waitFor: async () => {} }
  assert.equal(await submitOwnedEvaluationItemDialog(page, dialog, itemId, expected), response)
})

test('PB129 reads the actual template table controls in displayed order', async () => {
  const page = {
    locator: (selector) => {
      assert.equal(selector, '.template-layout .split-config-table .el-table__row')
      return {
        count: async () => templateRows.length,
        nth: (index) => ({
          locator: (selector) => {
            assert.equal(selector, 'td')
            return {
              nth: (column) => ({
                innerText: async () => templateRows[index].name,
                locator: (selector) => {
                  if (column === 2) return { innerText: async () => templateRows[index].methodLabel }
                  if (column === 4) {
                    assert.equal(selector, '.el-switch')
                    return checkboxSwitch(templateRows[index].required)
                  }
                  assert.equal(selector, 'input')
                  return { inputValue: async () => column === 3
                    ? templateRows[index].score : templateRows[index].sortNo }
                }
              })
            }
          }
        })
      }
    }
  }
  assert.deepEqual(await readEvaluationTemplateRows(page), templateRows)
  assert.equal(assertEvaluationTemplateRows(templateRows, snapshot), true)
})

test('PB129 rejects blank pages, current-master projections and drifting table controls', () => {
  for (const rows of [[], [...templateRows].reverse(), templateRows.slice(1)]) {
    assert.throws(() => assertEvaluationTemplateRows(rows, snapshot))
  }
  for (const change of [
    { name: 'CURRENT-MASTER-CHOICE' }, { methodLabel: '多选' }, { score: '70' },
    { required: true }, { sortNo: '3' }
  ]) {
    const changed = structuredClone(templateRows)
    changed[1] = { ...changed[1], ...change }
    assert.throws(() => assertEvaluationTemplateRows(changed, snapshot))
  }
  assert.throws(() => assertEvaluationTemplateRows([], { items: [] }))
  assert.throws(() => assertEvaluationTemplateRows(templateRows, {
    items: snapshot.items.map((item) => ({ ...item, evaluationTypeSnapshot: 'UNKNOWN' }))
  }))
})

test('r22 switch DOM reads the inner role=switch checkbox, including disabled true and actual false', async () => {
  for (const checked of [true, false]) {
    const input = switchNode({ ariaChecked: String(checked), checked })
    assert.equal(await readEvaluationSwitchState(switchLocator([input]), 'template required'), checked)
  }
})

test('switch state may come from a real checkbox property or explicit semantic aria, never wrapper styling', async () => {
  for (const checked of [true, false]) {
    assert.equal(await readEvaluationSwitchState(
      switchLocator([switchNode({ role: null, checked })]), 'checkbox'), checked)
    const roleRoot = switchNode({
      tagName: 'BUTTON', type: undefined, ariaChecked: String(checked)
    })
    assert.equal(await readEvaluationSwitchState(switchLocator([], roleRoot), 'role switch'), checked)
  }
  const decorativeRoot = switchNode({
    tagName: 'DIV', type: undefined, role: null, ariaChecked: 'false'
  })
  decorativeRoot.className = 'el-switch is-checked'
  await assert.rejects(readEvaluationSwitchState(switchLocator([], decorativeRoot), 'wrapper'),
    /switch must resolve uniquely/)
})

test('switch states reject absent, invalid, conflicting and duplicate controls without assuming false', async () => {
  for (const [controls, message] of [
    [[], /switch must resolve uniquely/],
    [[switchNode({ tagName: 'BUTTON', type: undefined })], /missing switch state/],
    [[switchNode({ ariaChecked: '' })], /missing switch state/],
    [[switchNode({ ariaChecked: 'mixed' })], /missing switch state/],
    [[switchNode({ ariaChecked: 'true', checked: false })], /conflicting switch state/],
    [[switchNode({ ariaChecked: null, checked: 'false' })], /invalid checkbox state/],
    [[switchNode(), switchNode()], /switch must resolve uniquely/]
  ]) {
    await assert.rejects(readEvaluationSwitchState(switchLocator(controls), 'required'), message)
  }
})

test('switch DOM and wait failures propagate instead of becoming an unchecked value', async () => {
  for (const stage of ['waitFor', 'evaluate']) {
    const locator = checkboxSwitch(false)
    locator[stage] = async () => { throw new Error(`${stage}: detached switch`) }
    await assert.rejects(readEvaluationSwitchState(locator, 'required'), /detached switch/)
  }
})

const selectHarness = ({
  controls = 'el-id-8858-54', optionCount = 1, selectedLabel = 'PB128-CATEGORY-B',
  label = 'PB128-CATEGORY-B', trialGate, failure
} = {}) => {
  const events = []
  let stable = false
  let selected = false
  let resolveTrial
  const trialStarted = new Promise((resolve) => { resolveTrial = resolve })
  const option = {
    waitFor: async ({ state }) => {
      assert.equal(state, 'visible')
      events.push('option-visible')
      if (failure === 'option') throw new Error('owned option missing')
      await new Promise((resolve) => setImmediate(resolve))
    },
    click: async (options) => {
      if (options?.trial) {
        events.push('option-trial')
        resolveTrial()
        if (failure === 'trial') throw new Error('option not stable/enabled')
        await trialGate
        stable = true
        events.push('option-stable')
      } else {
        assert.equal(stable, true, 'must await option actionability')
        assert.equal(optionCount, 1, 'must not click duplicate options')
        events.push('option-click')
        selected = true
      }
    },
    count: async () => {
      assert.equal(stable, true, 'queryCount must not run before the delayed option is stable')
      events.push('option-count')
      return optionCount
    }
  }
  const listboxSelector = `[role="listbox"][id=${JSON.stringify(controls)}]`
  const popup = {
    waitFor: async ({ state }) => {
      events.push(`popup-${state}`)
      if (state === 'hidden') assert.equal(selected, true)
      else {
        assert.equal(state, 'visible')
        if (failure === 'popup') throw new Error('owned active popup missing')
      }
    },
    locator: (selector) => {
      assert.equal(selector, listboxSelector)
      return {
        getByRole: (role, options) => {
          assert.equal(role, 'option')
          assert.deepEqual(options, { name: label, exact: true })
          return option
        }
      }
    }
  }
  const select = {
    click: async () => events.push('select-click'),
    locator: (selector) => {
      if (selector === 'input[role="combobox"][aria-expanded="true"]') return {
        waitFor: async ({ state }) => {
          // r22's readonly combobox is in .is-hidden; attachment, not visibility, is required.
          assert.equal(state, 'attached')
          events.push('combobox-expanded')
        },
        getAttribute: async (name) => {
          assert.equal(name, 'aria-controls')
          return controls
        }
      }
      if (selector === 'input[role="combobox"][aria-expanded="false"]') return {
        waitFor: async ({ state }) => {
          assert.equal(state, 'attached')
          assert.equal(selected, true)
          events.push('combobox-collapsed')
        }
      }
      assert.equal(selector,
        '.el-select__selection > .el-select__selected-item:not(.el-select__input-wrapper)')
      return { innerText: async () => selectedLabel }
    }
  }
  const page = {
    locator: (selector) => {
      if (selector === listboxSelector) return { ownedListbox: controls }
      assert.equal(selector, '.el-popper.el-select__popper[aria-hidden="false"]:visible')
      return {
        filter: ({ has }) => {
          assert.equal(has.ownedListbox, controls)
          events.push('owned-active-popup')
          return popup
        }
      }
    }
  }
  const formField = {
    locator: (selector) => {
      assert.equal(selector, '.el-select')
      return select
    }
  }
  return { page, formField, events, trialStarted }
}

test('r22 select waits for its owned active popup and delayed option stability before counting or clicking', async () => {
  let releaseTrial
  const trialGate = new Promise((resolve) => { releaseTrial = resolve })
  const harness = selectHarness({ trialGate })
  const choosing = selectEvaluationOption(harness.page, harness.formField, 'PB128-CATEGORY-B')
  await harness.trialStarted
  assert.deepEqual(harness.events, [
    'select-click', 'combobox-expanded', 'owned-active-popup', 'popup-visible',
    'option-visible', 'option-trial'
  ])
  releaseTrial()
  await choosing
  assert.deepEqual(harness.events.slice(6), [
    'option-stable', 'option-count', 'option-click', 'combobox-collapsed', 'popup-hidden'
  ])
})

test('select uses exact option names in the combobox listbox, not global hidden or foreign popup text', async () => {
  const label = 'PB128-CATEGORY[+].B'
  const harness = selectHarness({ label, selectedLabel: label })
  await selectEvaluationOption(harness.page, harness.formField, label)
  assert.equal(harness.events.filter((event) => event === 'owned-active-popup').length, 1)
  assert.equal(harness.events.filter((event) => event === 'option-click').length, 1)
})

test('select refuses missing ownership, missing/unstable options, duplicates and wrong saved labels', async () => {
  for (const [options, message] of [
    [{ controls: null }, /identify its own listbox/],
    [{ controls: 'two ids' }, /identify its own listbox/],
    [{ failure: 'popup' }, /owned active popup missing/],
    [{ failure: 'option' }, /owned option missing/],
    [{ failure: 'trial' }, /option not stable\/enabled/],
    [{ optionCount: 2 }, /evaluation option must resolve uniquely/],
    [{ selectedLabel: 'FOREIGN' }, /selected label did not persist/]
  ]) {
    const harness = selectHarness(options)
    await assert.rejects(selectEvaluationOption(harness.page, harness.formField, 'PB128-CATEGORY-B'), message)
    if (options.selectedLabel !== 'FOREIGN') assert.ok(!harness.events.includes('option-click'))
  }
})
