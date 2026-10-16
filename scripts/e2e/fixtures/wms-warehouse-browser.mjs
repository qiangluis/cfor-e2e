import assert from 'node:assert/strict'
import { isBusinessSuccess } from '../lib/assertions.mjs'

export const switchState = async (dialog) => {
  const result = {}
  for (const [key, label] of [['areaEnabled', '启用库区'], ['locationEnabled', '启用库位']]) {
    const control = dialog.locator('.el-form-item').filter({ hasText: label })
      .locator('input[role="switch"]')
    assert.equal(await control.count(), 1, `${label}只能命中一个控件`)
    result[key] = await control.getAttribute('aria-checked') === 'true'
  }
  return result
}

const openWarehouseEditor = async (page, warehouse) => {
  const search = page.locator('input[placeholder="请输入仓库名称"]').first()
  await search.fill(String(warehouse.name))
  const node = page.locator('.el-tree-node').filter({ hasText: String(warehouse.name) }).first()
  assert.equal(await node.count(), 1, '专属仓库树必须唯一匹配')
  await node.locator('.el-tree-node__content').first().click()
  await page.getByRole('button', { name: '编辑', exact: true }).first().click()
  const dialog = page.getByRole('dialog').last()
  await dialog.waitFor({ state: 'visible' })
  assert.equal(await dialog.getByPlaceholder('请输入助记码').inputValue(), String(warehouse.code))
  return dialog
}

const saveEditor = async (page, dialog, warehouse) => {
  const [response] = await Promise.all([
    page.waitForResponse((reply) =>
      reply.url().includes('/mes/wmsWareHouse/edit') &&
      ['PUT', 'POST'].includes(reply.request().method()), { timeout: 20000 }),
    dialog.getByRole('button', { name: /确\s*定/, exact: true }).click()
  ])
  assert.ok(response.ok(), `仓库页面保存 HTTP ${response.status()}`)
  const payload = await response.json()
  assert.ok(isBusinessSuccess(payload), '仓库页面保存必须业务成功')
  const request = response.request().postDataJSON()
  assert.equal(String(request.id), String(warehouse.id))
  await dialog.waitFor({ state: 'hidden' })
}

export async function verifyWarehouseBrowserPersistence ({
  page, api, warehouse, caseRecord, openRoute, route, saveScreenshot, record, outputDir
}) {
  await openRoute(page, route, { readySelector: 'input[placeholder="请输入仓库名称"]' })
  let dialog = await openWarehouseEditor(page, warehouse)
  try {
    const name = dialog.getByPlaceholder('请输入仓库名称')
    const invalidRequests = []
    const observeSave = (request) => {
      if (request.url().includes('/mes/wmsWareHouse/edit') &&
        ['PUT', 'POST'].includes(request.method())) invalidRequests.push(request.url())
    }
    const beforeInvalid = await api.getBusiness(`/mes/wmsWareHouse/queryById?id=${warehouse.id}`)
    page.on('request', observeSave)
    try {
      await name.fill('')
      await dialog.getByRole('button', { name: /确\s*定/, exact: true }).click()
      await dialog.locator('.el-form-item__error').filter({ hasText: '请输入仓库名称' })
        .waitFor({ state: 'visible' })
      const afterInvalid = await api.getBusiness(`/mes/wmsWareHouse/queryById?id=${warehouse.id}`)
      caseRecord.checks.push({
        name: '仓库页面必填校验仅显示字段错误且零写入原值不变',
        passed: invalidRequests.length === 0 &&
          JSON.stringify(beforeInvalid.data) === JSON.stringify(afterInvalid.data),
        details: `warehouse=${warehouse.id}; editRequests=${invalidRequests.length}`
      })
    } finally {
      page.off('request', observeSave)
      await name.fill(String(warehouse.name))
    }
    const area = dialog.locator('.el-form-item').filter({ hasText: '启用库区' }).locator('.el-switch')
    const location = dialog.locator('.el-form-item').filter({ hasText: '启用库位' }).locator('.el-switch')
    if (!(await switchState(dialog)).areaEnabled) await area.click()
    if (!(await switchState(dialog)).locationEnabled) await location.click()
    await saveEditor(page, dialog, warehouse)
    const enabled = await api.getBusiness(`/mes/wmsWareHouse/queryById?id=${warehouse.id}`)
    const enabledPass = enabled.data?.areaEnabled === true && enabled.data?.locationEnabled === true
    caseRecord.checks.push({
      name: '仓库页面真实启用库区库位并保存到服务端',
      passed: enabledPass,
      details: `warehouse=${warehouse.id}`
    })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('input[placeholder="请输入仓库名称"]').first().waitFor({ state: 'visible' })
    dialog = await openWarehouseEditor(page, warehouse)
    const initial = await switchState(dialog)
    await area.click()
    const afterToggle = await switchState(dialog)
    await saveEditor(page, dialog, warehouse)
    const closed = await api.getBusiness(`/mes/wmsWareHouse/queryById?id=${warehouse.id}`)
    const closedPass = closed.data?.areaEnabled === false && closed.data?.locationEnabled === false

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('input[placeholder="请输入仓库名称"]').first().waitFor({ state: 'visible' })
    dialog = await openWarehouseEditor(page, warehouse)
    const finalState = await switchState(dialog)
    const passed = enabledPass && closedPass &&
      initial.areaEnabled === true && initial.locationEnabled === true &&
      afterToggle.areaEnabled === false && afterToggle.locationEnabled === false &&
      finalState.areaEnabled === false && finalState.locationEnabled === false
    caseRecord.checks.push({
      name: '仓库页面关闭库区联动关闭库位并经保存刷新回读',
      passed,
      details: JSON.stringify({ initial, afterToggle, finalState })
    })
    await saveScreenshot(page, outputDir, 'wms-qc-008-page-saved-refreshed', record)
  } finally {
    if (await dialog.isVisible()) {
      await dialog.getByRole('button', { name: /取\s*消/, exact: true }).click()
    }
  }
}
