import assert from 'node:assert/strict'

import { observePage } from '../lib/browser.mjs'
import { decryptResponse, ENCRYPT_HEADER } from '../lib/crypto.mjs'

export const matchesOwnedPartnerQuery = (response, partnerCode) => {
  const url = new URL(response.url())
  return response.request().method() === 'GET' &&
    url.pathname.endsWith('/base/partner/page') &&
    url.searchParams.get('keyword') === partnerCode &&
    url.searchParams.get('pageNo') === '1' &&
    url.searchParams.get('pageSize') === '100'
}

export const assertOwnedPartnerPage = (payload, partner) => {
  assert.equal(payload?.code, 0, 'Partner page business failure')
  assert.notEqual(payload.success, false)
  assert.match(String(partner?.id ?? ''), /^[1-9]\d*$/)
  assert.ok(partner.partnerCode && partner.name)
  const rows = payload.data?.list
  assert.ok(Array.isArray(rows), 'Missing partner page rows')
  assert.equal(Number(payload.data.total), 1, 'Partner query must return only its owned positive control')
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(String(row.id), String(partner.id), 'Partner page leaked or returned the wrong identity')
  assert.equal(row.partnerCode, partner.partnerCode)
  assert.equal(row.name, partner.name)
  assert.ok(partner.taxNo, 'Missing owned partner tax number')
  assert.equal(row.taxNo, partner.taxNo)
  for (const field of ['customerEnabled', 'supplierEnabled', 'carrierEnabled']) {
    assert.equal(row[field], true, `Missing partner role ${field}`)
  }
  return row
}

export const queryOwnedPartnerInBrowser = async (page, partner) => {
  await page.locator('.el-table .el-loading-mask').waitFor({ state: 'hidden' })
  await observePage(page).flushResponses()
  await page.getByPlaceholder('名称 / 编码 / 税号', { exact: true }).fill(partner.partnerCode)
  const [response] = await Promise.all([
    page.waitForResponse((item) => matchesOwnedPartnerQuery(item, partner.partnerCode)),
    page.getByRole('button', { name: '查询', exact: true }).click()
  ])
  assert.ok(response.ok(), `Partner page HTTP ${response.status()}`)
  const text = await response.text()
  const payload = response.headers()[ENCRYPT_HEADER.toLowerCase()] === 'true'
    ? decryptResponse(text) : JSON.parse(text)
  const row = assertOwnedPartnerPage(payload, partner)
  const rendered = page.locator('.el-table__body-wrapper .el-table__row')
    .filter({ hasText: partner.partnerCode })
  await rendered.waitFor({ state: 'visible' })
  await page.locator('.el-table .el-loading-mask').waitFor({ state: 'hidden' })
  const rowText = await rendered.innerText()
  for (const value of [partner.partnerCode, partner.name, partner.taxNo,
    '客户', '供应商', '承运商', '启用']) {
    assert.ok(rowText.includes(value), `Partner row did not render ${value}`)
  }
  await observePage(page).flushResponses()
  return { row, rowText }
}
