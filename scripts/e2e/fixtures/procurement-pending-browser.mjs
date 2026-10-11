import { randomBytes } from 'node:crypto'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { decryptResponse, ENCRYPT_HEADER } from '../lib/crypto.mjs'

const dataOf = (payload, label) => assertBusinessSuccess(payload, label).data
const stableId = (value, label) => {
  if (!/^[1-9]\d*$/.test(String(value ?? ''))) throw new Error(`${label}未返回稳定 ID`)
  return String(value)
}

async function browserPayload (response) {
  const text = await response.text()
  return response.headers()[ENCRYPT_HEADER.toLowerCase()] === 'true'
    ? decryptResponse(text)
    : JSON.parse(text)
}

export function assertPendingSaleSelection (payload, { saleOrderId, saleOrder, material }) {
  if (!/^[1-9]\d*$/.test(String(saleOrderId)) ||
      !Array.isArray(payload?.data?.list) || payload.data.list.length !== 1) {
    throw new Error('PROC-017 浏览器来源查询未唯一返回专属销售订单')
  }
  const source = payload.data.list[0]
  const item = source.items?.[0]
  if (String(source.id) !== String(saleOrderId) ||
      source.billNo !== saleOrder.billNo || Number(source.status) !== 20 ||
      source.items?.length !== 1 || String(item?.productId) !== String(material.id) ||
      String(item?.productUnitId) !== String(material.unitId) || Number(item?.count) !== 2) {
    throw new Error('PROC-017 浏览器销售来源身份、审核状态或明细不一致')
  }
  return source
}

export function assertPendingRequestPayload (payload, { saleOrderId, saleOrder, material }) {
  const item = payload?.itemsList?.[0]
  if (payload?.srcBillType !== 'sale' || String(payload.srcBillId) !== String(saleOrderId) ||
      payload.srcNo !== saleOrder.billNo || Number(payload.status) !== 0 ||
      payload.itemsList?.length !== 1 || String(item?.productId) !== String(material.id) ||
      String(item?.productUnitId) !== String(material.unitId) || Number(item?.inCount) !== 2 ||
      Object.hasOwn(payload, 'pendingSourceId')) {
    throw new Error('PROC-017 浏览器生成请求未保留准确来源、物料、单位或数量')
  }
  return payload
}

export async function createPendingRequestBrowserFixture (api, caseRecord, generateRequest) {
  if (typeof generateRequest !== 'function') throw new Error('PROC-017 必须使用真实浏览器生成')
  const tag = `PROC017_${Date.now().toString(36).toUpperCase()}_${randomBytes(2).toString('hex')}`
  const fixture = {
    kind: 'procurement-pending-request', tag, status: 'creating', retained: true,
    reason: '保留未审核请购和销售来源关联，避免破坏来源追溯审计'
  }
  caseRecord.fixtures = [...(caseRecord.fixtures || []), fixture]
  const name = `E2E-PROC017-CUSTOMER-${tag}`
  const customerId = stableId(dataOf(await api.postBusiness('/base/partner/create', {
    name, shortName: name.slice(0, 12), partnerKind: 'ORGANIZATION', status: 'ACTIVE',
    customerEnabled: true, supplierEnabled: false, carrierEnabled: false, remark: name
  }), 'PROC-017 专属客户创建'), 'PROC-017 专属客户')
  fixture.customerId = customerId
  const materialPage = dataOf(await api.getBusiness(
    '/mes/basMaterial/list/dictText?pageNo=1&pageSize=100&saled=Y&isEnabled=1'
  ), 'PROC-017 可销售物料')
  const material = materialPage?.records?.find((row) =>
    /^[1-9]\d*$/.test(String(row?.id)) && /^[1-9]\d*$/.test(String(row?.unitId)))
  if (!material) throw new Error('BLOCKED: PROC-017 没有可销售物料及单位')
  const orderTime = new Date().toISOString().slice(0, 19)
  const saleOrderId = stableId(dataOf(await api.postBusiness('/erp/sale-order/create', {
    customerId, orderTime, billDate: orderTime.slice(0, 10),
    discountPercent: 0, discountPrice: 0, depositPrice: 0,
    totalCount: 2, totalProductPrice: 20, totalTaxPrice: 0, totalPrice: 20,
    remark: `PROC-017 sale source ${tag}`,
    items: [{
      entryNo: 1, productId: String(material.id), productUnitId: String(material.unitId),
      productPrice: 10, count: 2, taxPercent: 0, totalPrice: 20, taxPrice: 0,
      remark: `PROC-017 sale source line ${tag}`
    }]
  }), 'PROC-017 销售来源创建'), 'PROC-017 销售来源')
  fixture.saleOrderId = saleOrderId
  const saleOrder = dataOf(await api.getBusiness(
    `/erp/sale-order/get?id=${encodeURIComponent(saleOrderId)}`
  ), 'PROC-017 销售来源详情')
  const generated = await generateRequest({ saleOrderId, saleOrder, material, fixture })
  if (generated?.viaBrowser !== true) throw new Error('PROC-017 未由真实浏览器生成')
  assertPendingRequestPayload(generated.payload, { saleOrderId, saleOrder, material })
  const requestId = stableId(dataOf(generated.response, 'PROC-017 浏览器生成请购'), 'PROC-017 请购')
  fixture.requestId = requestId
  const request = dataOf(await api.getBusiness(
    `/erp/purchase/order/request/get?id=${encodeURIComponent(requestId)}`
  ), 'PROC-017 请购回读')
  const item = request?.itemsList?.[0]
  if (String(request?.id) !== requestId || request.srcBillType !== 'sale' ||
      String(request.srcBillId) !== saleOrderId || request.srcNo !== saleOrder.billNo ||
      !request.billNo || String(request.billStage) !== '14' ||
      Number(request.isEffective) !== 0 || Number(request.isClosed) !== 0 ||
      request.itemsList?.length !== 1 || Number(item?.inCount) !== 2 ||
      String(item?.productId) !== String(material.id) ||
      String(item?.productUnitId) !== String(material.unitId)) {
    throw new Error('PROC-017 请购回读未保留来源、未审核状态或准确物料数量')
  }
  Object.assign(fixture, {
    status: 'verified', generatedViaBrowser: true, billNo: request.billNo,
    cleanup: 'request-and-sale-order-retained'
  })
  return { saleOrderId, saleOrder, requestId, request,
    requestPayload: generated.payload, material, fixture }
}

export async function verifyGeneratedRequestList (page, write, { caseRecord, capture }) {
  await page.getByPlaceholder('请输入请购单号', { exact: true }).fill(write.request.billNo)
  const [response] = await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname.endsWith('/erp/purchase/order/request/page') &&
        url.searchParams.get('billNo') === write.request.billNo
    }),
    page.getByRole('button', { name: '搜索', exact: true }).click()
  ])
  const result = assertBusinessSuccess(await browserPayload(response), 'Chrome 生成后请购查询')
  const rows = result.data?.records
  if (rows?.length !== 1 || String(rows[0].id) !== write.requestId ||
      rows[0].itemsList?.length !== 1 || Number(rows[0].itemsList[0].inCount) !== 2) {
    throw new Error('PROC-017 页面未唯一回读本轮生成请购及明细数量')
  }
  await page.locator('button:visible')
    .filter({ hasText: write.request.billNo }).first().waitFor({ state: 'visible' })
  caseRecord.checks.push({
    name: 'Chrome 按生成单号唯一回读本轮未审核请购和数量',
    passed: true, details: `billNo=${write.request.billNo}; requestId=${write.requestId}; count=2`
  })
  await capture('erp-purchase-request-generated-filtered')
}

export async function generatePendingRequestInBrowser (page, source, {
  caseRecord, capture
}) {
  const dialog = page.locator('.el-dialog:visible').last()
  await dialog.getByRole('tab', { name: '销售订单', exact: true }).click()
  await dialog.getByPlaceholder('请输入订单单号').fill(source.saleOrder.billNo)
  const [listResponse] = await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname.endsWith('/erp/sale-order/page') &&
        url.searchParams.get('billNo') === source.saleOrder.billNo
    }),
    dialog.getByRole('button', { name: '搜索', exact: true }).click()
  ])
  const list = assertBusinessSuccess(await browserPayload(listResponse), '浏览器销售来源查询')
  assertPendingSaleSelection(list, source)
  const row = dialog.locator('.vxe-table--main-wrapper .vxe-body--row')
    .filter({ hasText: source.saleOrder.billNo })
  await row.waitFor({ state: 'visible' })
  // VXE mirrors fixed selection columns in an invisible main-table cell.
  await row.locator('td').filter({ hasText: source.saleOrder.billNo }).click()
  const generate = dialog.getByRole('button', { name: '生成请购', exact: true })
  await generate.waitFor({ state: 'visible' })
  if (!(await generate.isEnabled())) throw new Error('PROC-017 勾选来源后生成按钮仍禁用')
  await capture('erp-purchase-request-selected-sale-source')
  await generate.click()
  const confirmation = page.locator('.el-message-box:visible')
  await confirmation.waitFor({ state: 'visible' })
  await capture('erp-purchase-request-confirm-generation')
  const [response] = await Promise.all([
    page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/erp/purchase/order/request/create') &&
        response.request().method() === 'POST'),
    confirmation.getByRole('button', { name: /^确\s*[定认]$/ }).click()
  ])
  const payload = assertPendingRequestPayload(response.request().postDataJSON(), source)
  const result = assertBusinessSuccess(await browserPayload(response), '浏览器一键生成请购')
  await dialog.waitFor({ state: 'hidden' })
  caseRecord.checks.push({
    name: 'Chrome 选择专属销售来源明细并确认一键生成请购',
    passed: true,
    details: `saleOrderId=${source.saleOrderId}; requestId=${result.data}; billNo=${source.saleOrder.billNo}`
  })
  await capture('erp-purchase-request-generated-sale-source')
  return { response: result, payload, viaBrowser: true }
}
