import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const base = process.env.CFOR_FIXTURE_URL || 'http://localhost:9151'
const output = process.env.CFOR_FIXTURE_OUTPUT || '/tmp/cfor-pb034-page-20261015'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({
  executablePath:
    process.env.CFOR_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true
})
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', (error) => {
    errors.push(error.message)
    console.error(error.message)
  })
  await page.goto(`${base}/tests/fixtures/partner-master.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  })
  await page.getByRole('cell', { name: '双角色演示企业', exact: true }).waitFor()
  const dialog = page.getByRole('dialog').filter({ hasText: /新增客商|编辑客商/ })
  const field = (label) =>
    dialog.locator('.el-form-item').filter({
      has: page.locator('.el-form-item__label', { hasText: new RegExp(`^${label}$`) })
    })
  await page.getByRole('button', { name: '新增客商', exact: true }).click()
  await field('客商名称').getByRole('textbox').fill('新增双角色客商')
  await dialog.getByRole('button', { name: '确定', exact: true }).click()
  await dialog.getByText('请至少勾选一种客商身份', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.pb034Fixture.creates.length), 0)
  await dialog.getByRole('checkbox', { name: '客户', exact: true }).locator('..').click()
  await dialog.getByRole('checkbox', { name: '供应商', exact: true }).locator('..').click()
  await dialog.getByRole('tab', { name: '联系人', exact: true }).click()
  await dialog.getByRole('button', { name: '新增联系人', exact: true }).click()
  const contactRow = dialog
    .getByRole('tabpanel', { name: '联系人', exact: true })
    .locator('.el-table__body tr')
    .first()
  await contactRow.getByRole('textbox', { name: '姓名', exact: true }).fill('共用联系人')
  await contactRow.getByRole('checkbox', { name: '客户默认', exact: true }).locator('..').click()
  await contactRow.getByRole('checkbox', { name: '供应商默认', exact: true }).locator('..').click()
  await page.screenshot({ path: `${output}/create-both.png`, fullPage: true })
  await dialog.getByRole('button', { name: '确定', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const created = await page.evaluate(() => window.pb034Fixture.creates)
  assert.equal(created.length, 1)
  assert.equal(created[0].customerEnabled, true)
  assert.equal(created[0].supplierEnabled, true)
  assert.equal(created[0].contactsList[0].isDefault, true)
  assert.equal(created[0].contactsList[0].supplierDefault, true)

  const row = page.locator('.el-table__body tr').filter({ hasText: '双角色演示企业' }).first()
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  await dialog.getByRole('tab', { name: '客户属性', exact: true }).click()
  await field('客户分类').getByRole('combobox').waitFor()
  assert.match(await field('客户等级').innerText(), /客户A级/)
  await dialog.getByRole('tab', { name: '供应商属性', exact: true }).click()
  assert.match(await field('供应商等级').innerText(), /供应商B级/)
  await field('客商名称').getByRole('textbox').fill('双角色企业更新')
  await dialog.getByRole('tab', { name: '银行信息', exact: true }).click()
  assert.equal(
    await dialog.getByRole('tabpanel', { name: '银行信息', exact: true }).locator('input[type="password"]').inputValue(),
    'TEST-001'
  )
  await dialog.getByRole('button', { name: '确定', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const updated = await page.evaluate(() => window.pb034Fixture.updates[0])
  assert.equal(updated.id, 100)
  assert.equal(updated.customerCategoryId, 'CG')
  assert.equal(updated.supplierCategoryId, 'SG')
  assert.equal(updated.customerCreditLimit, 10000)
  assert.equal(updated.supplierCreditLimit, 20000)
  assert.equal(updated.contactsList[0].id, 201)
  assert.equal(updated.bankList[0].id, 301)
  assert.equal(updated.invoiceList[0].id, 401)

  const identity = page
    .locator('.partner-list__query .el-form-item')
    .filter({ hasText: '客商身份' })
    .locator('.el-select')
  await identity.click()
  const listbox = await identity.getByRole('combobox').getAttribute('aria-controls')
  await page
    .locator(`#${listbox}`)
    .getByRole('option', { name: '客户及供应商', exact: true })
    .click()
  await page.waitForFunction(
    () =>
      window.pb034Fixture.queries.at(-1).customerEnabled === true &&
      window.pb034Fixture.queries.at(-1).supplierEnabled === true
  )
  assert.equal(await page.getByRole('cell', { name: '客户演示企业', exact: true }).count(), 0)
  await page.getByRole('button', { name: '重置', exact: true }).click()
  await page.getByRole('cell', { name: '客户演示企业', exact: true }).waitFor()

  await page.evaluate(() => {
    window.pb034Fixture.failDetail = true
  })
  await page
    .locator('.el-table__body tr')
    .filter({ hasText: '双角色企业更新' })
    .first()
    .getByRole('button', { name: '编辑', exact: true })
    .click()
  await dialog.getByText('模拟详情加载失败', { exact: true }).waitFor()
  assert.equal(await dialog.getByRole('button', { name: '确定', exact: true }).isDisabled(), true)
  await page.evaluate(() => {
    window.pb034Fixture.failDetail = false
  })
  await dialog.getByRole('button', { name: '重新加载', exact: true }).click()
  await field('客商名称').getByRole('textbox').waitFor()
  await dialog.getByRole('tab', { name: '联系人', exact: true }).click()
  for (const [width, height] of [
    [1440, 1000],
    [1280, 720],
    [390, 844]
  ]) {
    await page.setViewportSize({ width, height })
    await page.screenshot({ path: `${output}/${width}-edit.png`, fullPage: true })
    const layout = await dialog.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const badFields = Array.from(
        element.querySelectorAll('.partner-form__grid .el-form-item')
      ).filter((item) => {
        if (!item.checkVisibility()) return false
        const bounds = item.getBoundingClientRect()
        return bounds.x < box.x - 1 || bounds.right > box.right + 1
      }).length
      return { width: box.width, left: box.left, right: box.right, badFields }
    })
    assert.ok(
      layout.width <= width && layout.left >= 0 && layout.right <= width,
      `Dialog overflow at ${width}`
    )
    assert.equal(layout.badFields, 0, `Form fields overflow at ${width}`)
  }
  assert.deepEqual(errors, [])
  console.log(`PB-034 real component fixture PASS; screenshots: ${output}`)
} finally {
  await browser.close()
}
