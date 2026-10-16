import assert from 'node:assert/strict'
import fs from 'node:fs'
import { launchBrowser } from './lib/browser.mjs'

const base = process.env.CFOR_WEB_BASE || 'http://localhost:9151'
assert.match(base, /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/, 'Use a local dev server only')
const output = '/tmp/cfor-pb032-form-20261013'
fs.mkdirSync(output, { recursive: true })
const record = { consoleErrors: [], pageErrors: [], failedApiResponses: [] }
const { browser, context, page } = await launchBrowser({ headed: false, record })
try {
  // A regression fixture must never reach a business backend or an external host.
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== new URL(base).origin || url.pathname.startsWith('/admin-api/')) {
      await route.abort()
    } else {
      await route.continue()
    }
  })
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 }
  ]) {
    await page.setViewportSize(viewport)
    await page.goto(`${base}/tests/fixtures/material-master.html`)
    await page.waitForFunction(() => Boolean(window.pb032Fixture))
    await page.evaluate(() => window.pb032Fixture.open())
    const dialog = page.getByRole('dialog').first()
    await dialog.getByRole('button', { name: '确 定', exact: true }).waitFor()
    await page.waitForFunction(() => !document.querySelector('.el-dialog__footer button')?.disabled)
    await page.waitForTimeout(350)
    const footer = dialog.locator('.el-dialog__footer')
    assert.equal(await footer.isVisible(), true)
    const footerBox = await footer.boundingBox()
    const viewportSize = page.viewportSize()
    assert.ok(
      footerBox &&
        viewportSize &&
        footerBox.y + footerBox.height <= viewportSize.height + 1,
      `Dialog footer must remain visible at ${viewportSize?.width}x${viewportSize?.height}: ${JSON.stringify(
        { footerBox, viewportSize }
      )}`
    )
    assert.equal(await dialog.getByText('计量单位', { exact: true }).count(), 1)
    const basicLabels = await dialog
      .locator('.material-basic-grid .el-form-item__label')
      .allTextContents()
    for (const legacyLabel of ['主单位', '计量单位方案', '辅助单位', '换算率']) {
      assert.equal(basicLabels.includes(legacyLabel), false)
    }
    const unitPicker = dialog.locator('.material-unit-selector .el-cascader')
    const removedUnitSummary =
      '.material-unit-selector__detail, .material-unit-selector__empty'
    assert.equal(await dialog.locator(removedUnitSummary).count(), 0)
    await unitPicker.click()
    await page
      .locator('.el-cascader-node')
      .filter({ hasText: '固定换算组' })
      .hover()
    await page
      .locator('.el-cascader-node')
      .filter({ hasText: '1箱12件' })
      .click()
    await dialog.locator('.material-help-panel').getByText('1箱等于12件', { exact: true }).waitFor()
    assert.equal(await dialog.locator(removedUnitSummary).count(), 0)
    for (const legacyLabel of ['单位组/类型', '是否成品', '是否组装件', '是包件', '参与齐套计算']) {
      assert.equal(await dialog.getByText(legacyLabel, { exact: true }).count(), 0)
    }
    for (const label of [
      '存货属性',
      '存货控制',
      '包装',
      '质量',
      '存货描述',
      '自定义项',
      '附件信息'
    ]) {
      await dialog.getByRole('tab', { name: label, exact: true }).click()
      if (label === '质量') {
        assert.equal(
          await dialog.locator('.el-tab-pane:visible input[type="checkbox"]:checked').count(),
          2
        )
        assert.equal(await dialog.getByText('已发布质检方案', { exact: true }).count(), 1)
      }
      if (label === '存货描述') {
        await dialog.getByRole('button', { name: '添加图片' }).click()
        const upload = dialog.locator('input[type=file]').first()
        assert.match(await upload.getAttribute('accept'), /image\/png/)
        await dialog.getByPlaceholder('图片名称（必填）').fill('正面图')
        await upload.setInputFiles({
          name: 'owned-product.png',
          mimeType: 'image/png',
          buffer: fs.readFileSync(
            new URL('../../public/assets/icons/tech/database_generic.png', import.meta.url)
          )
        })
        await dialog.locator('.upload-image').waitFor()
      }
      if (label === '附件信息') {
        await dialog.getByRole('button', { name: '添加附件' }).click()
        await dialog.getByPlaceholder('文件编号').fill('MANUAL-001')
        await dialog.getByPlaceholder('文件名', { exact: true }).fill('操作手册')
        await dialog.getByPlaceholder('文件摘要').fill('生产操作说明')
        const upload = dialog.locator('.el-tab-pane:visible input[type=file]').first()
        await upload.setInputFiles({
          name: 'owned-manual.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.4\n%%EOF')
        })
        await dialog.getByText('owned-manual.pdf', { exact: true }).waitFor()
        await upload.setInputFiles({
          name: 'second-manual.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.4\n%%EOF')
        })
        assert.equal(await dialog.getByText('second-manual.pdf', { exact: true }).count(), 0)
      }
      if (label === '自定义项') {
        assert.equal(await dialog.getByText('用途', { exact: true }).count(), 1)
        assert.equal(await dialog.getByText('适用类别', { exact: true }).count(), 1)
      }
      await page.screenshot({
        path: `${output}/${viewport.width}-${label}.png`,
        fullPage: true,
        animations: 'disabled'
      })
    }
    assert.equal(await page.evaluate(() => window.pb032Fixture.saved.length), 0)
    const overflow = await dialog.evaluate(
      (element) => element.scrollWidth > element.clientWidth + 2
    )
    assert.equal(overflow, false, `Dialog overflow at ${viewport.width}`)
    await dialog.getByRole('button', { name: '确 定', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const saved = await page.evaluate(() => window.pb032Fixture.saved)
    assert.equal(saved[0].id, '9223372036854775001')
    assert.equal(saved[0].unitId, 'U2')
    assert.equal(saved[0].unitGroupId, 'S1')
    assert.equal(saved[0].auxUnitId, 'U1')
    assert.equal(saved[0].auxUnitFactor, 12)
    assert.equal(JSON.parse(saved[0].productImagesJson)[0].name, '正面图')
    assert.equal(JSON.parse(saved[0].attachmentItemsJson)[0].fileNo, 'MANUAL-001')
    assert.equal(saved[0].mesBasMaterialProperty.packingGrow, 10)
    assert.equal('innerPackingGrow' in saved[0].mesBasMaterialProperty, false)
    assert.deepEqual(saved[0].allowedGradeIds, ['G1', 'G2'])
  }
  assert.deepEqual(record.pageErrors, [])
  console.log(`PB-032 real component browser regression passed; screenshots: ${output}`)
} catch (error) {
  console.error(JSON.stringify(record, null, 2))
  console.error(
    await page.locator('.el-form-item__error, .el-message__content').allTextContents()
  )
  console.error(await page.evaluate(() => window.pb032Fixture?.saved ?? null))
  console.error(await page.evaluate(() => window.pb032Fixture?.snapshot?.() ?? null))
  await page.screenshot({ path: `${output}/failure.png`, fullPage: true, animations: 'disabled' })
  throw error
} finally {
  await browser.close()
}
