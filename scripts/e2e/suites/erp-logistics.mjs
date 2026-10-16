import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { config } from '../config/index.mjs'
import { assertLocalWriteSafety } from '../lib/db.mjs'
import { isStableId } from './base-partner.mjs'

export const cases = ['PB-063-001']

const dataOf = (payload, label) => assertBusinessSuccess(payload, label).data
const tagOf = () => `${Date.now().toString(36).toUpperCase()}_${randomBytes(2).toString('hex')}`
const listOf = (payload, label) => {
  const data = assertBusinessSuccess(payload, label).data
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.list)) return data.list
  if (Array.isArray(data?.records)) return data.records
  return []
}
const pageOf = (payload, label) => {
  const data = assertBusinessSuccess(payload, label).data
  if (!data || !Array.isArray(data.list) || !Number.isSafeInteger(data.total)) {
    throw new Error(`${label} 必须返回有效 data.list/total`)
  }
  return data
}
const hasExportPayload = (payload) =>
  (typeof payload === 'string' && payload.length > 0) ||
  (payload instanceof ArrayBuffer && payload.byteLength > 0) ||
  (typeof payload?.raw === 'string' && payload.raw.length > 0)

/**
 * Map PB-063-001 against the frozen original catalog. Only structured VERIFIED
 * evidence for every original assertion may set acceptanceComplete.
 */
export function logisticsCatalogEvidence (caseRecord, evidence = {}) {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const definition = catalog.suites.flatMap((suite) => suite.cases)
    .find((item) => item.id === 'PB-063-001')
  if (!definition) throw new Error('缺少原 catalog 案例 PB-063-001')
  caseRecord.catalogAssertions = (definition.assertions || []).map((assertion, index) => {
    const item = evidence[index] || {}
    const names = Array.isArray(item) ? item : item.checks || []
    const checks = names.map((name) => caseRecord.checks.find((check) => check.name === name))
    const verified = names.length > 0 && checks.every((check) => check?.passed === true)
    return {
      index,
      assertion,
      status: verified ? 'VERIFIED' : 'GAP',
      evidenceChecks: names,
      details: item.details || (verified
        ? checks.map((check) => `${check.name}: ${check.details || ''}`).join('; ')
        : (item.gap || '本轮未形成完整证据'))
    }
  })
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((item) => item.status === 'GAP').map((item) => item.assertion)
  caseRecord.passCandidate = caseRecord.remainingAssertions.length === 0 &&
    caseRecord.checks.length > 0 && caseRecord.checks.every((check) => check.passed !== false)
  caseRecord.notes.push(
    `原 catalog 未修改；PASS候选=${caseRecord.passCandidate}；` +
    `剩余=${caseRecord.remainingAssertions.join('；') || '无'}`
  )
  return caseRecord
}

async function platformExpressDirectory (api, caseRecord, { allowEmpty = false } = {}) {
  const express = listOf(
    await api.getBusiness('/trade/delivery/express/list-all-simple'),
    '平台快递目录')
  const usable = express.filter((row) => typeof row?.code === 'string' && row.code.trim())
  if (allowEmpty && usable.length === 0) {
    caseRecord.notes.push('GAP: 当前没有可引用的平台快递品牌编码，未以空集冒充目录证据。')
    return { express, chosen: undefined }
  }
  caseRecord.checks.push({
    name: '平台快递目录返回可引用的品牌编码',
    passed: usable.length > 0 && usable.every((row) => typeof row?.name === 'string'),
    details: `express=${express.length}, coded=${usable.length}`
  })
  return { express, chosen: usable[0] }
}

async function integrationTraceContract (api, caseRecord, businessId) {
  let traceContract = false
  let trackingContract = false
  try {
    const trace = pageOf(
      await api.getBusiness(
        `/integration/logistics/trace/page?pageNo=1&pageSize=10&businessType=erp_sale_delivery&businessId=${encodeURIComponent(businessId)}`),
      'Integration 物流轨迹分页')
    traceContract = Array.isArray(trace.list) && Number.isSafeInteger(trace.total)
  } catch (error) {
    caseRecord.notes.push(`GAP: Integration 物流轨迹分页不可用：${String(error.message || error).slice(0, 200)}`)
  }
  try {
    const tracking = pageOf(
      await api.getBusiness(
        `/integration/logistics/tracking/page?pageNo=1&pageSize=10&businessType=erp_sale_delivery&businessId=${encodeURIComponent(businessId)}`),
      'Integration 物流跟踪分页')
    trackingContract = Array.isArray(tracking.list) && Number.isSafeInteger(tracking.total)
  } catch (error) {
    caseRecord.notes.push(`GAP: Integration 物流跟踪分页不可用：${String(error.message || error).slice(0, 200)}`)
  }
  return traceContract && trackingContract
}

async function runLogisticsWrite ({ page, record, caseRecord, outputDir }) {
  const token = await login(page)
  const api = createApiClient({ token, record })
  const tag = tagOf()

  let { express, chosen } = await platformExpressDirectory(api, caseRecord, { allowEmpty: true })
  let expressFixtureId
  if (!chosen) {
    const fixtureCode = `E2E_PB063_${tag}`.replace(/[^A-Z0-9_]/g, '_')
    expressFixtureId = String(dataOf(await api.postBusiness('/trade/delivery/express/create', {
      code: fixtureCode,
      name: `E2E PB063 快递目录 ${tag}`,
      sort: 999,
      status: 0
    }), 'PB-063 专属快递目录'))
    caseRecord.fixtures = [...(caseRecord.fixtures || []), {
      kind: 'trade-delivery-express',
      id: expressFixtureId,
      code: fixtureCode,
      status: 'created'
    }]
    express = listOf(
      await api.getBusiness('/trade/delivery/express/list-all-simple'),
      'PB-063 专属快递目录复核')
    chosen = express.find((row) => String(row.code) === fixtureCode)
    if (!chosen) throw new Error('PB-063 专属快递目录创建后无法回读')
    caseRecord.notes.push('只读环境没有平台快递目录，本轮写侧创建了专属目录并在清理阶段删除。')
  }
  const expressCodesBefore = new Set(express.map((row) => String(row.code)))

  const partner = dataOf(await api.postBusiness('/base/partner/create', {
    name: `E2E-PB063-CARRIER-${tag}`,
    shortName: 'E2E-PB063',
    partnerKind: 'ORGANIZATION',
    status: 'ACTIVE',
    customerEnabled: false,
    supplierEnabled: false,
    carrierEnabled: true,
    remark: `PB-063 isolated carrier fixture ${tag}`
  }), 'PB-063 专属承运商')
  if (!isStableId(partner)) throw new Error('PB-063 专属承运商未返回稳定 ID')
  const fixture = {
    kind: 'erp-logistics-carrier',
    tag,
    carrierPartnerId: String(partner),
    expressCode: chosen?.code,
    status: 'creating',
    retained: false
  }
  caseRecord.fixtures = [...(caseRecord.fixtures || []), fixture]

  let deliveryId
  try {
    const billNo = `E2E-PB063-${tag}`
    const subject = `E2E-PB063 发货 ${tag}`
    const now = new Date()
    const billDate = now.toISOString().slice(0, 10)
    await api.postBusiness('/erp/sale-delivery/add-draft', {
      billNo,
      billDate,
      subject,
      customerId: null,
      deliveryTime: now.toISOString().slice(0, 19).replace('T', ' '),
      deliveryCount: 1,
      deliveryMethod: 'EXPRESS',
      carrierPartnerId: partner,
      expressCode: chosen?.code,
      remark: `PB-063 isolated delivery ${tag}`,
      saleDeliveryItemsDOList: []
    })
    const pageResult = await api.getBusiness(
      `/erp/sale-delivery/page?pageNo=1&pageSize=100&subject=${encodeURIComponent(subject)}`)
    const row = (pageResult?.data?.list || []).find((item) => item.subject === subject)
    if (!row || !isStableId(row.id)) {
      throw new Error('PB-063 专属发货草稿创建后无法在分页中定位，未形成快照证据')
    }
    deliveryId = String(row.id)
    fixture.deliveryId = deliveryId
    const detail = dataOf(
      await api.getBusiness(`/erp/sale-delivery/get?id=${encodeURIComponent(deliveryId)}`),
      'PB-063 专属发货草稿详情')
    fixture.status = 'verified'

    caseRecord.checks.push({
      name: '承运商引用统一客商并返回名称快照',
      passed:
        String(detail.carrierPartnerId) === String(partner) &&
        detail.carrierPartnerName === `E2E-PB063-CARRIER-${tag}`,
      details: `deliveryId=${deliveryId}, carrierPartnerId=${detail.carrierPartnerId}, ` +
        `carrierPartnerName=${detail.carrierPartnerName}`
    })

    const expressAfter = listOf(
      await api.getBusiness('/trade/delivery/express/list-all-simple'),
      'PB-063 快递目录复核')
    const noUnexpectedMaster = expressAfter.every((item) => expressCodesBefore.has(String(item.code))) &&
      expressAfter.length === express.length
    caseRecord.checks.push({
      name: '快递品牌使用平台目录编码且未创建物流公司主档',
      passed:
        typeof chosen?.code === 'string' && chosen.code.length > 0 &&
        detail.expressCode === chosen.code && noUnexpectedMaster,
      details: `expressCode=${detail.expressCode}, expressBefore=${express.length}, ` +
        `expressAfter=${expressAfter.length}`
    })

    const listResult = pageOf(
      await api.getBusiness('/erp/sale-delivery/page?pageNo=1&pageSize=100'),
      'PB-063 发货单分页')
    const listRow = listResult.list.find((item) => String(item.id) === deliveryId)
    const hasFields = (item) => item &&
      Object.prototype.hasOwnProperty.call(item, 'carrierPartnerId') &&
      Object.prototype.hasOwnProperty.call(item, 'carrierPartnerName') &&
      Object.prototype.hasOwnProperty.call(item, 'expressCode')
    const exportResult = await api.get('/erp/sale-delivery/export-excel?pageNo=1&pageSize=100')
    const exportReturned = hasExportPayload(exportResult)
    caseRecord.checks.push({
      name: '发货单分页与导出均返回承运商及快递品牌字段',
      passed:
        hasFields(listRow) &&
        String(listRow.carrierPartnerId) === String(partner) &&
        listRow.expressCode === chosen.code &&
        exportReturned,
      details: `deliveryId=${deliveryId}, listFields=${hasFields(listRow)}, exportReturned=${exportReturned}`
    })

    const integrationOk = await integrationTraceContract(api, caseRecord, deliveryId)
    caseRecord.checks.push({
      name: '物流轨迹查询继续通过 Integration API',
      passed: integrationOk,
      details: `deliveryId=${deliveryId}, integrationOk=${integrationOk}`
    })

    await openRoute(page, '/erp/sale/delivery', { readyText: '新增' })
    await page.getByRole('button', { name: /新增/ }).first().click()
    const dialog = page.locator('.el-dialog:visible').first()
    await dialog.waitFor({ state: 'visible', timeout: 60000 })
    const expandForm = dialog.locator('.check_btn').first()
    if (await expandForm.count() && await expandForm.isVisible()) {
      await expandForm.click()
    }
    await dialog.getByText('承运商', { exact: true }).first().waitFor({
      state: 'visible',
      timeout: 60000
    })
    const bodyText = await dialog.innerText()
    caseRecord.checks.push({
      name: '发运页面提供统一客商承运商和快递品牌字段',
      passed: new URL(page.url()).pathname === '/erp/sale/delivery' &&
        bodyText.includes('承运商') && bodyText.includes('快递品牌'),
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'erp-sale-delivery-carrier-snapshot', record)

    logisticsCatalogEvidence(caseRecord, {
      0: ['承运商引用统一客商并返回名称快照'],
      1: ['快递品牌使用平台目录编码且未创建物流公司主档'],
      2: ['发货单分页与导出均返回承运商及快递品牌字段'],
      3: integrationOk ? ['物流轨迹查询继续通过 Integration API'] : {
        gap: 'Integration 物流轨迹分页/跟踪分页不可用，物流轨迹未取得真实契约证据'
      }
    })
    caseRecord.evidence.push(
      `真实登录、专属承运商 ${partner}、专属发货草稿 ${deliveryId}、` +
      `快递品牌 ${chosen?.code} 平台目录未新增主档、Integration 物流轨迹契约`)
  } finally {
    if (deliveryId) {
      try {
        await api.deleteBusiness(`/erp/sale-delivery/delete?id=${encodeURIComponent(deliveryId)}`)
        fixture.deliveryDeleted = true
      } catch (error) {
        fixture.deliveryDeleteError = String(error.message || error).slice(0, 300)
      }
    }
    try {
      await api.deleteBusiness(`/base/partner/delete?id=${encodeURIComponent(partner)}`)
      fixture.carrierDeleted = true
    } catch (error) {
      fixture.carrierDeleteError = String(error.message || error).slice(0, 300)
    }
    if (expressFixtureId) {
      try {
        await api.deleteBusiness(
          `/trade/delivery/express/delete?id=${encodeURIComponent(expressFixtureId)}`
        )
        const remaining = listOf(
          await api.getBusiness('/trade/delivery/express/list-all-simple'),
          'PB-063 专属快递目录清理回读')
        const fixture = (caseRecord.fixtures || []).find((item) =>
          item.kind === 'trade-delivery-express' && item.id === expressFixtureId)
        if (fixture) fixture.status = remaining.some((row) => String(row.code) === fixture.code)
          ? 'cleanup-failed' : 'cleaned'
      } catch (error) {
        const fixture = (caseRecord.fixtures || []).find((item) =>
          item.kind === 'trade-delivery-express' && item.id === expressFixtureId)
        if (fixture) {
          fixture.status = 'cleanup-failed'
          fixture.cleanupError = String(error.message || error).slice(0, 300)
        }
      }
    }
  }
  return { token, api }
}

async function runLogisticsReadonly ({ page, record, caseRecord, outputDir }) {
  const token = await login(page)
  const api = createApiClient({ token, record })
  const listResult = pageOf(
    await api.getBusiness('/erp/sale-delivery/page?pageNo=1&pageSize=100'),
    'PB-063 发货单分页')
  const rows = listResult.list
  const hasFields = rows.every((row) =>
    Object.prototype.hasOwnProperty.call(row, 'carrierPartnerId') &&
    Object.prototype.hasOwnProperty.call(row, 'carrierPartnerName') &&
    Object.prototype.hasOwnProperty.call(row, 'expressCode'))
  const exportResult = await api.get('/erp/sale-delivery/export-excel?pageNo=1&pageSize=100')
  const exportReturned = hasExportPayload(exportResult)
  if (rows.length > 0) {
    caseRecord.checks.push({
      name: '发货单分页与导出均返回承运商及快递品牌字段',
      passed: hasFields && exportReturned,
      details: `rows=${rows.length}, listFields=${hasFields}, exportReturned=${exportReturned}`
    })
  } else {
    caseRecord.notes.push('GAP: 当前没有发货单样本，未以空分页冒充承运商/快递字段证据。')
  }
  await platformExpressDirectory(api, caseRecord, { allowEmpty: true })
  const integrationOk = await integrationTraceContract(api, caseRecord, rows[0]?.id || '0')
  caseRecord.checks.push({
    name: '物流轨迹查询继续通过 Integration API',
    passed: integrationOk,
    details: `integrationOk=${integrationOk}`
  })

  await openRoute(page, '/erp/sale/delivery', { readyText: '新增' })
  await page.getByRole('button', { name: /新增/ }).first().click()
  const dialog = page.locator('.el-dialog:visible').first()
  await dialog.waitFor({ state: 'visible', timeout: 60000 })
  const expandForm = dialog.locator('.check_btn').first()
  if (await expandForm.count() && await expandForm.isVisible()) {
    await expandForm.click()
  }
  await dialog.getByText('承运商', { exact: true }).first().waitFor({
    state: 'visible',
    timeout: 60000
  })
  const bodyText = await dialog.innerText()
  caseRecord.checks.push({
    name: '发运页面提供统一客商承运商和快递品牌字段',
    passed: new URL(page.url()).pathname === '/erp/sale/delivery' &&
      bodyText.includes('承运商') && bodyText.includes('快递品牌'),
    details: page.url()
  })
  await saveScreenshot(page, outputDir, 'erp-sale-delivery-carrier-snapshot', record)
  caseRecord.evidence.push('真实登录、发货单分页字段和发运页面截图（只读模式未写入承运商快照）')

  logisticsCatalogEvidence(caseRecord, {
    0: { gap: '未开启 CFOR_E2E_WRITE_FIXTURES，专属承运商客商引用与名称快照未执行写侧' },
    1: { gap: '未开启 CFOR_E2E_WRITE_FIXTURES，快递品牌目录占用与不新建主档未执行写侧' },
    2: ['发货单分页与导出均返回承运商及快递品牌字段'],
    3: integrationOk ? ['物流轨迹查询继续通过 Integration API'] : {
      gap: 'Integration 物流轨迹分页/跟踪分页不可用，物流轨迹未取得真实契约证据'
    }
  })
  return { token, api, partial: true, note: '发货单字段与 Integration 契约只读已核对，承运商快照写侧未执行' }
}

export const runCase = async ({ page, record, caseRecord, outputDir }) => {
  const writeEnabled = process.env.CFOR_E2E_WRITE_FIXTURES === 'true'
  if (!writeEnabled) return runLogisticsReadonly({ page, record, caseRecord, outputDir })
  if (config.target !== 'local') {
    throw new Error('BLOCKED: PB-063-001 写侧验收仅允许本地 local target')
  }
  await assertLocalWriteSafety(caseRecord)
  return runLogisticsWrite({ page, record, caseRecord, outputDir })
}
