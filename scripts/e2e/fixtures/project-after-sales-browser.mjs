import { observePage, openRoute, waitForPageReady } from '../lib/browser.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { decryptResponse, ENCRYPT_HEADER } from '../lib/crypto.mjs'

const visibleDialog = (page) => page.locator('.el-dialog:visible').last()

const formInput = (dialog, label) =>
  dialog.locator('.el-form-item').filter({ hasText: label }).locator('input, textarea').first()

const selectedFormLabel = async (dialog, label) => {
  const selection = dialog.locator('.el-form-item').filter({ hasText: label })
    .locator('.el-select__selection > .el-select__selected-item:not(.el-select__input-wrapper)')
  return (await selection.innerText()).trim()
}

export const readIssueCategoryForm = async (dialog) => ({
  categoryCode: await formInput(dialog, '模型编码').inputValue(),
  categoryName: await formInput(dialog, '模型名称').inputValue(),
  productLabel: await selectedFormLabel(dialog, '适用产品类型'),
  assetLabel: await selectedFormLabel(dialog, '适用资产类型'),
  serviceLabel: await selectedFormLabel(dialog, '适用服务状态')
})

export const assertIssueCategoryForm = (form, expected) => {
  const wanted = {
    categoryCode: expected.categoryCode,
    categoryName: expected.persistedName,
    productLabel: {
      HARDWARE: '硬件设备', SOFTWARE: '软件系统', DATA_SERVICE: '数据服务'
    }[expected.productType] || expected.productType,
    assetLabel: {
      SERVER: '服务器', NETWORK: '网络设备', LICENSE: '软件许可'
    }[expected.assetType] || expected.assetType,
    serviceLabel: {
      IN_SERVICE: '服务中', SERVICE_SUSPENDED: '暂停服务', SERVICE_EXPIRED: '服务到期'
    }[expected.serviceStatus] || expected.serviceStatus
  }
  const mismatched = Object.keys(wanted).filter((key) =>
    typeof wanted[key] !== 'string' || !wanted[key] || form[key] !== wanted[key])
  if (mismatched.length) {
    throw new Error(`PB120 刷新表单字段不一致：${mismatched.map((key) =>
      `${key}=${JSON.stringify(form[key])}，期望=${JSON.stringify(wanted[key])}`).join('；')}`)
  }
  return true
}

const assertPageText = (text, expected, label) => {
  const missing = expected.filter((value) => !String(text || '').includes(value))
  if (missing.length) {
    throw new Error(`${label}页面真实内容不完整，缺少：${missing.join('、')}`)
  }
  return true
}

const pageStorageKeysToClear = (keys) =>
  keys.filter((key) => /after[-_ ]?sales|aftersales/i.test(String(key)))

export const clearAfterSalesPageLocalState = async (page) =>
  page.evaluate(() => {
    const removed = []
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (const key of Object.keys(storage)) {
        if (/after[-_ ]?sales|aftersales/i.test(key)) {
          storage.removeItem(key)
          removed.push(key)
        }
      }
    }
    return removed
  })

export const pageStorageKeysForAfterSales = pageStorageKeysToClear

const selectAfterSalesSettingsTab = async (page, tabLabel) => {
  await page.locator('.modeling-panel').waitFor({ state: 'visible' })
  const tab = page.locator('.el-tabs__item').filter({ hasText: tabLabel }).first()
  await tab.waitFor({ state: 'visible' })
  await tab.click()
  await page.locator('.modeling-panel .el-loading-mask').waitFor({ state: 'hidden' })
  await observePage(page).flushResponses()
  return page.locator('body').innerText()
}

export const openAfterSalesSettingsTab = async (page, tabLabel) => {
  await openRoute(page, '/after-sales/settings', { readyText: '售后建模' })
  return selectAfterSalesSettingsTab(page, tabLabel)
}

export const reloadAfterSalesSettingsTab = async (page, tabLabel) => {
  await observePage(page).flushResponses()
  await clearAfterSalesPageLocalState(page)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForPageReady(page)
  // Select the tab in the refreshed document; a second navigation can cancel bootstrap requests.
  return selectAfterSalesSettingsTab(page, tabLabel)
}

export const browserBusinessPayload = async (response) => {
  if (!response.ok()) throw new Error(`售后页面请求 HTTP ${response.status()}`)
  const text = await response.text()
  const body = response.headers()[ENCRYPT_HEADER.toLowerCase()] === 'true'
    ? decryptResponse(text) : JSON.parse(text)
  return assertBusinessSuccess(body, '售后真实浏览器保存').data
}

const requestPayload = (response) => {
  const request = response.request()
  return request.headers()[ENCRYPT_HEADER.toLowerCase()] === 'true'
    ? decryptResponse(request.postData()) : request.postDataJSON()
}

export const isExpectedAssetProfileResponse = (response, expected) => {
  const url = new URL(response.url())
  if (response.request().method() !== 'PUT' ||
      !url.pathname.endsWith('/after-sales/asset/customer-profile/update')) return false
  const payload = requestPayload(response)
  return String(payload?.customerId) === String(expected.customerId) &&
    payload?.assets?.some((asset) => String(asset?.id) === String(expected.assetId)) === true
}

const losslessId = (value) => /^(?:[1-9]\d*)$/.test(String(value ?? '')) &&
  (typeof value !== 'number' || Number.isSafeInteger(value))

export const assertIssueCategoryWrite = (response, payload, expected) => {
  const url = new URL(response.url())
  if (url.searchParams.get('id') !== String(expected.categoryId) ||
      payload.categoryCode !== expected.categoryCode ||
      payload.categoryName !== expected.persistedName ||
      String(payload.parentId || '0') !== String(expected.parentId || '0') ||
      payload.applicableProductType !== expected.productType ||
      payload.applicableAssetType !== expected.assetType ||
      payload.applicableServiceStatus !== expected.serviceStatus) {
    throw new Error('PB120 浏览器分类保存身份或适用范围不一致')
  }
}

export const assertAssetProfileWrite = (payload, expected) => {
  const asset = payload?.assets?.[0]
  const period = asset?.newServicePeriods?.find((row) =>
    row.sourceNo === expected.servicePeriod.sourceNo)
  if (!losslessId(payload?.customerId) ||
      String(payload.customerId) !== String(expected.customerId) ||
      payload.assets?.length !== 1 || !losslessId(asset?.id) ||
      String(asset.id) !== String(expected.assetId) || asset.assetNo !== expected.assetNo ||
      asset.contactIds?.length !== 1 || !losslessId(asset.contactIds[0]) ||
      String(asset.contactIds[0]) !== String(expected.contactId) ||
      asset.managers?.length !== 1 ||
      asset.managers[0].managerName !== expected.managerName ||
      asset.managers[0].managerMobile !== expected.managerMobile ||
      !period || period.sourceType !== 'MANUAL' ||
      period.startDate !== expected.servicePeriod.startDate ||
      period.endDate !== expected.servicePeriod.endDate ||
      period.sourceName !== expected.servicePeriod.sourceName) {
    throw new Error('PB125 浏览器保存未精确包含专属资产、联系人、责任人与追加服务期')
  }
}

export const saveIssueCategoryInBrowser = async (
  page,
  expected,
  { capture = async () => {} } = {}
) => {
  const { categoryCode, originalName, persistedName } = expected
  await openAfterSalesSettingsTab(page, '问题分类')
  await page.locator('.category-tree-node').filter({ hasText: originalName }).first().click()
  const row = page.locator('.category-leaf-table .el-table__row')
    .filter({ hasText: categoryCode }).first()
  await row.waitFor({ state: 'visible' })
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  const dialog = visibleDialog(page)
  await formInput(dialog, '模型名称').fill(persistedName)
  const [response] = await Promise.all([
    page.waitForResponse((item) => {
      const url = new URL(item.url())
      return item.request().method() === 'PUT' &&
        url.pathname.endsWith('/after-sales/modeling/category/update')
    }),
    dialog.getByRole('button', { name: '保存', exact: true }).click()
  ])
  assertIssueCategoryWrite(response, requestPayload(response), expected)
  await browserBusinessPayload(response)
  await dialog.waitFor({ state: 'hidden' })
  await observePage(page).flushResponses()
  await capture('pb120-category-saved')
  const refreshedText = await reloadAfterSalesSettingsTab(page, '问题分类')
  await page.locator('.category-tree-node').filter({ hasText: persistedName }).first().click()
  const refreshedRow = page.locator('.category-leaf-table .el-table__row')
    .filter({ hasText: categoryCode }).first()
  await refreshedRow.waitFor({ state: 'visible' })
  const rowText = await refreshedRow.innerText()
  assertPageText(rowText, [categoryCode, persistedName], 'PB120 问题分类')
  await refreshedRow.getByRole('button', { name: '编辑', exact: true }).click()
  const reloadedDialog = visibleDialog(page)
  const values = await readIssueCategoryForm(reloadedDialog)
  assertIssueCategoryForm(values, expected)
  await capture('pb120-category-reloaded')
  await reloadedDialog.getByRole('button', { name: '取消', exact: true }).click()
  return { refreshedText, rowText, values }
}

export const saveAssetProfileInBrowser = async (
  page,
  expected,
  { capture = async () => {} } = {}
) => {
  const { assetNo, managerName, managerMobile, servicePeriod, contactName } = expected
  await openAfterSalesSettingsTab(page, '客户资产')
  await page.getByPlaceholder('编码 / 名称 / 适用范围').fill(assetNo)
  const row = page.locator('.business-table .el-table__row')
    .filter({ hasText: assetNo }).first()
  await row.waitFor({ state: 'visible' })
  await row.getByRole('button', { name: '维护', exact: true }).click()
  const dialog = visibleDialog(page)
  await dialog.locator('.asset-profile-table .el-table__row')
    .filter({ hasText: assetNo }).first().locator('.el-table__expand-icon').click()

  const managerRow = dialog.locator('.responsibility-table .el-table__row').first()
  const managerInputs = managerRow.locator('input')
  await managerInputs.nth(1).fill(managerName)
  await managerInputs.nth(2).fill(managerMobile)

  const contactSelect = dialog.locator('.relation-block')
    .filter({ hasText: '资产联系人' }).locator('.el-select')
  await contactSelect.locator('.el-tag__close').first().click()
  await contactSelect.click()
  await page.locator('.el-select-dropdown:visible .el-select-dropdown__item')
    .filter({ hasText: contactName }).first().click()
  await dialog.locator('.section-title h3').first().click()

  await dialog.getByRole('button', { name: '新增服务期限', exact: true }).click()
  const periodRow = dialog.locator('.service-period-table .el-table__row').last()
  const dateInputs = periodRow.locator('.el-date-editor input')
  await dateInputs.nth(0).fill(servicePeriod.startDate)
  await dateInputs.nth(0).press('Tab')
  await dateInputs.nth(1).fill(servicePeriod.endDate)
  await dateInputs.nth(1).press('Tab')
  await periodRow.getByPlaceholder('合同/审批/续费依据编号').fill(servicePeriod.sourceNo)
  await periodRow.getByPlaceholder('请填写人工新增依据').fill(servicePeriod.sourceName)

  const [response] = await Promise.all([
    page.waitForResponse((item) => isExpectedAssetProfileResponse(item, expected)),
    dialog.getByRole('button', { name: '保存', exact: true }).click()
  ])
  assertAssetProfileWrite(requestPayload(response), expected)
  await browserBusinessPayload(response)
  await dialog.waitFor({ state: 'hidden' })
  await observePage(page).flushResponses()
  await capture('pb125-asset-saved')

  const refreshedText = await reloadAfterSalesSettingsTab(page, '客户资产')
  await page.getByPlaceholder('编码 / 名称 / 适用范围').fill(assetNo)
  const reopenedRow = page.locator('.business-table .el-table__row')
    .filter({ hasText: assetNo }).first()
  await reopenedRow.getByRole('button', { name: '维护', exact: true }).click()
  const refreshedDialog = visibleDialog(page)
  await refreshedDialog.locator('.asset-profile-table .el-table__row')
    .filter({ hasText: assetNo }).first().locator('.el-table__expand-icon').click()
  const profileText = `${await refreshedDialog.innerText()} ${await refreshedDialog
    .locator('input, textarea').evaluateAll((inputs) => inputs.map((input) => input.value).join(' '))}`
  assertPageText(profileText, [
    assetNo,
    managerName,
    managerMobile,
    contactName,
    servicePeriod.startDate,
    servicePeriod.endDate,
    servicePeriod.sourceNo,
    servicePeriod.sourceName
  ], 'PB125 客户资产')
  await capture('pb125-asset-reloaded')
  await refreshedDialog.locator('.responsibility-table').scrollIntoViewIfNeeded()
  await capture('pb125-asset-responsibility-reloaded')
  await refreshedDialog.getByRole('button', { name: '取消', exact: true }).click()
  return { listText: refreshedText, profileText }
}

export const assertExpiredAssetRiskRow = (text, expected) => assertPageText(text, [
  expected.assetNo, expected.startDate, expected.endDate, '服务到期'
], 'PB125 到期资产风险')

export const verifyExpiredAssetInBrowser = async (
  page,
  expected,
  { capture = async () => {} } = {}
) => {
  await reloadAfterSalesSettingsTab(page, '客户资产')
  await page.getByPlaceholder('编码 / 名称 / 适用范围').fill(expected.assetNo)
  const row = page.locator('.business-table .el-table__row')
    .filter({ hasText: expected.assetNo }).first()
  await row.waitFor({ state: 'visible' })
  const text = await row.innerText()
  assertExpiredAssetRiskRow(text, expected)
  const warning = row.locator('.el-tag--danger').filter({ hasText: '服务到期' })
  await warning.waitFor({ state: 'visible' })
  await observePage(page).flushResponses()
  await capture('pb125-expired-asset-risk')
  return text
}

export const assertDutyPagePersistence = (text, expected) => assertPageText(text, [
  '值班转接规则',
  expected.dutyRole,
  expected.employeeName,
  expected.date,
  expected.phone,
  expected.serviceScope,
  expected.startTime,
  expected.endTime,
  expected.nonServiceTip,
  `${expected.timeoutMinutes} 分钟后转备班角色`
], 'PB130 值班服务')

export const assertDutyRosterRow = (text, expected) => assertPageText(text, [
  expected.dutyRole, expected.employeeName, expected.date,
  expected.phone, expected.serviceScope, expected.startTime, expected.endTime, '人工'
], 'PB130 专属 HRM 排班行')

const verifySelectedDuty = async (page, expected) => {
  const row = page.locator('.roster-table .el-table__row').filter({
    hasText: expected.dutyRole
  })
  await row.waitFor({ state: 'visible' })
  assertDutyRosterRow(await row.innerText(), expected)
  const text = await page.locator('.duty-workspace').innerText()
  assertDutyPagePersistence(text, expected)
  return text
}

export const assertDutyRuleWrite = (payload, expected) => {
  if (!losslessId(payload?.id) || String(payload.id) !== String(expected.ruleId) ||
      payload.dutyRole !== expected.dutyRole || payload.name !== expected.name ||
      payload.phone !== expected.phone || payload.serviceScope !== expected.serviceScope ||
      payload.timeoutMinutes !== expected.timeoutMinutes ||
      payload.transferOrder !== expected.transferOrder ||
      payload.nonServiceTip !== expected.nonServiceTip || payload.enabled !== true) {
    throw new Error('PB130 浏览器保存的专属转接规则身份或字段不一致')
  }
}

export const verifyDutyPageInBrowser = async (
  page,
  expected,
  { capture = async () => {} } = {}
) => {
  const firstText = await openAfterSalesSettingsTab(page, '值班服务')
  const selectedRule = page.locator('.duty-aside > button')
    .filter({ hasText: expected.dutyRole }).first()
  await selectedRule.waitFor({ state: 'visible' })
  await selectedRule.click()
  await page.getByRole('button', { name: '编辑规则', exact: true }).click()
  const dialog = visibleDialog(page)
  for (const [label, value] of [
    ['规则名称', expected.name], ['值班电话', expected.phone],
    ['服务范围', expected.serviceScope], ['非服务时段提示', expected.nonServiceTip],
    ['转接顺序', expected.transferOrder], ['超时转备班（分钟）', expected.timeoutMinutes]
  ]) {
    await formInput(dialog, label).fill(String(value))
    await formInput(dialog, label).press('Tab')
  }
  const [saveResponse] = await Promise.all([
    page.waitForResponse((item) => item.request().method() === 'POST' &&
      new URL(item.url()).pathname.endsWith('/after-sales/duty/rule/save')),
    dialog.getByRole('button', { name: '保存', exact: true }).click()
  ])
  assertDutyRuleWrite(requestPayload(saveResponse), expected)
  const savedId = await browserBusinessPayload(saveResponse)
  if (String(savedId) !== String(expected.ruleId)) throw new Error('PB130 页面保存返回非专属规则ID')
  await dialog.waitFor({ state: 'hidden' })
  await observePage(page).flushResponses()
  const selectedText = await verifySelectedDuty(page, expected)
  await capture('pb130-duty-saved')

  const refreshedText = await reloadAfterSalesSettingsTab(page, '值班服务')
  const refreshedRule = page.locator('.duty-aside > button')
    .filter({ hasText: expected.dutyRole }).first()
  await refreshedRule.waitFor({ state: 'visible' })
  await refreshedRule.click()
  const reloadedText = await verifySelectedDuty(page, expected)
  await capture('pb130-duty-reloaded')
  return { firstText, selectedText, refreshedText, reloadedText }
}
