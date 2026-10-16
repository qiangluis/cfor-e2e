import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const base = process.env.CFOR_FIXTURE_URL || 'http://localhost:9151'
const output = process.env.CFOR_FIXTURE_OUTPUT || '/tmp/cfor-pb029-page-20261014'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({
  executablePath: process.env.CFOR_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true
})
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${base}/tests/fixtures/measuring-unit.html`)
  await page.getByRole('heading', { name: '无换算组', exact: true }).waitFor()
  await page.getByRole('cell', { name: '瓶', exact: true }).waitFor()
  await page.getByText('固定换算组', { exact: true }).first().click()
  await page.getByRole('cell', { name: '1箱等于12瓶', exact: true }).waitFor()
  await page.locator('.unit-settings__table .el-loading-mask').waitFor({ state: 'hidden' })
  await page.screenshot({ path: `${output}/desktop.png`, fullPage: true })
  await page.getByRole('button', { name: '新增方案', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByPlaceholder('例如：1箱12瓶').fill('1箱24瓶')
  const chooseUnit = async (label, name) => {
    const select = dialog.locator('.el-form-item').filter({ hasText: label }).locator('.el-select')
    await select.click()
    const listboxId = await select.getByRole('combobox').getAttribute('aria-controls')
    assert.ok(listboxId, `Missing listbox for ${label}`)
    await page.locator(`#${listboxId}`).getByRole('option', { name, exact: true }).click()
  }
  await chooseUnit('主单位', '箱')
  await chooseUnit('辅助单位', '瓶')
  await dialog.getByRole('spinbutton').fill('24')
  await dialog.getByTestId('conversion-description').getByText('1箱等于24瓶', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const fixed = await page.evaluate(() => window.pb029Fixture.saved[0])
  assert.equal(fixed.fixedRate, 24)
  assert.equal(fixed.mainUnitId, 'BOX')
  assert.equal(fixed.auxUnitId, 'BOTTLE')

  await page.getByText('浮动换算组', { exact: true }).first().click()
  await page.getByRole('cell', { name: '单据填写', exact: true }).waitFor()
  await page.getByRole('button', { name: '新增方案', exact: true }).click()
  await dialog.getByPlaceholder('例如：1箱12瓶').fill('箱瓶实际换算')
  await chooseUnit('主单位', '箱')
  await chooseUnit('辅助单位', '瓶')
  assert.equal(await dialog.getByRole('spinbutton').count(), 0)
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const floating = await page.evaluate(() => window.pb029Fixture.saved[1])
  assert.equal(floating.conversionMode, 'FLOATING')
  assert.equal(floating.fixedRate, null)
  await page.waitForFunction(() => !document.querySelector('.el-message'))
  for (const [width, height] of [[1440, 1000], [1280, 720], [390, 844]]) {
    await page.setViewportSize({ width, height })
    for (const [group, label, rowName] of [
      ['NONE', '无换算组', '瓶'],
      ['FIXED', '固定换算组', '1箱等于12瓶'],
      ['FLOATING', '浮动换算组', '单据填写']
    ]) {
      await page.getByText(label, { exact: true }).first().click()
      await page.getByRole('cell', { name: rowName, exact: true }).waitFor()
      await page.locator('.unit-settings__table .el-loading-mask').waitFor({ state: 'hidden' })
      const actions = page.locator('.unit-settings__actions')
      await actions.first().getByRole('button', { name: '修改', exact: true }).waitFor()
      const rows = await actions.evaluateAll((elements) =>
        elements.map((element) => {
          const cell = element.closest('td').getBoundingClientRect()
          return {
            cell: { x: cell.x, y: cell.y, width: cell.width, height: cell.height },
            buttons: Array.from(element.querySelectorAll('button'), (button) => {
              const box = button.getBoundingClientRect()
              return {
                name: button.textContent.trim(),
                x: box.x, y: box.y, width: box.width, height: box.height
              }
            })
          }
        })
      )
      assert.ok(rows.length > 0, `No action rows in ${group} at ${width}px`)
      for (const { cell, buttons } of rows) {
        const context = `${group} at ${width}px`
        assert.deepEqual(buttons.map((button) => button.name), ['修改', '删除'])
        assert.ok(cell.width >= 159, `Operation column too narrow: ${context}`)
        assert.ok(Math.abs(buttons[0].y - buttons[1].y) <= 1, `Actions wrapped: ${context}`)
        assert.ok(buttons[1].x >= buttons[0].x + buttons[0].width, `Actions overlap: ${context}`)
        for (const button of buttons) {
          assert.ok(button.x >= cell.x - 1, `Action clipped on the left: ${context}`)
          assert.ok(button.x + button.width <= cell.x + cell.width + 1, `Action clipped on the right: ${context}`)
          assert.ok(button.y >= cell.y - 1, `Action clipped above: ${context}`)
          assert.ok(button.y + button.height <= cell.y + cell.height + 1, `Action clipped below: ${context}`)
        }
      }
      await page.screenshot({ path: `${output}/${width}-${group}.png`, fullPage: true })
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
      assert.equal(overflow, false, `Unexpected horizontal page overflow in ${group} at ${width}px`)
    }
  }
  assert.deepEqual(errors, [])
  console.log(`PB-029 real component fixture PASS; screenshots: ${output}`)
} finally {
  await browser.close()
}
