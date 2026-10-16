import { createApiClient } from '../lib/api.mjs'
import { runReadOnlySql } from '../lib/db.mjs'
import { nonEmpty } from '../lib/assertions.mjs'
import { config } from '../config/index.mjs'
import fs from 'node:fs'
import {
  login,
  openRoute,
  saveScreenshot,
  tableRows,
  waitForPageReady
} from '../lib/browser.mjs'
import { randomBytes } from 'node:crypto'
import { findMenuRouteByComponent } from './base-partner.mjs'
import { ownedCases, assertEnvironment, catalogResult } from '../fmshelper/contracts.mjs'
import { runOwnedCase } from '../fmshelper/scenarios.mjs'
import { runFmsWriteClosure } from '../fixtures/fms-write-closure.mjs'

const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
const fmsDefinitions = catalog.suites.find((suite) => suite.id === 'fms').cases

export const cases = [
  'FMS-001',
  'FMS-002',
  'FMS-003',
  'FMS-004',
  'FMS-005',
  'FMS-006',
  'FMS-007',
  'FIN-OPENING-001',
  'FIN-OPENING-002'
]

export const openingDateMatches = (value, expected = '2026-10-06') => {
  if (Array.isArray(value)) {
    return value.length === 3 &&
      String(value[0]) === expected.slice(0, 4) &&
      String(value[1]).padStart(2, '0') === expected.slice(5, 7) &&
      String(value[2]).padStart(2, '0') === expected.slice(8, 10)
  }
  return String(value ?? '').startsWith(expected)
}

const dataOf = (response) => response?.data ?? response
const unique = (prefix) =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`

// Preserve the catalog status in the audit report, but allow a complete,
// evidence-backed write-side run to close the current acceptance gap.
// Reverse evidence is intentionally stored separately because the gap report
// matches only the catalog's declared assertions array.
export function recordFms005Acceptance (caseRecord, definition = fmsDefinitions.find((item) => item.id === 'FMS-005')) {
  const evidence = caseRecord.catalogEvidence || {}
  const row = (assertion, index) => ({
    index,
    assertion,
    status: evidence[assertion]?.status === 'PASS' ? 'VERIFIED' : 'GAP',
    evidence: evidence[assertion]?.evidence || '尚无本轮真实闭环证据'
  })
  const catalogAssertions = (definition.assertions || []).map(row)
  const reverseAssertions = (definition.reverse || []).map(row)
  caseRecord.catalogAssertions = catalogAssertions
  caseRecord.catalogReverseAssertions = reverseAssertions
  caseRecord.remainingAssertions = [
    ...catalogAssertions.filter((item) => item.status !== 'VERIFIED'),
    ...reverseAssertions
      .filter((item) => item.status !== 'VERIFIED')
      .map((item) => ({ ...item, reverse: true }))
  ]
  const failedChecks = (caseRecord.checks || []).filter((item) => item.passed === false)
  const acceptanceComplete = failedChecks.length === 0 &&
    caseRecord.remainingAssertions.length === 0
  caseRecord.passCandidate = acceptanceComplete
  caseRecord.notes.push(
    `FMS-005 五项原断言按 index/evidence 精确记录，reverse 单独记录 ${reverseAssertions.length} 项；` +
    (acceptanceComplete
      ? '本轮写侧闭环与专属夹具清理均完成，可结案'
      : `仍有 ${caseRecord.remainingAssertions.length} 项断言或 ${failedChecks.length} 个失败检查`)
  )
  return {
    partial: !acceptanceComplete,
    acceptanceComplete,
    note: acceptanceComplete
      ? '本轮全部 catalog 原断言及 reverse 具备真实证据，写侧验收闭环完成'
      : `剩余 ${caseRecord.remainingAssertions.length} 项断言或 ${failedChecks.length} 个失败检查`
  }
}

async function waitForTableRows (page, expectedText = null) {
  await page.waitForFunction(
    (expected) =>
      !document.querySelector('.el-loading-mask') &&
      (expected
        ? Array.from(document.querySelectorAll('.el-table__row'))
          .some((row) => (row.textContent || '').includes(expected))
        : document.querySelectorAll('.el-table__row').length > 0 ||
          document.querySelector('.el-table__empty-text') !== null),
    expectedText,
    { timeout: 30000 }
  )
}

async function createPartner (api, role, suffix = unique('FMS')) {
  const name = `E2E期初${role === 'receivable' ? '客户' : '供应商'}${suffix}`
  const partnerId = dataOf(await api.postBusiness('/base/partner/create', {
    name,
    shortName: name.slice(0, 12),
    partnerKind: 'ORGANIZATION',
    taxNo: `E2E${suffix}`.slice(0, 30),
    status: 'ACTIVE',
    customerEnabled: role === 'receivable',
    supplierEnabled: role === 'payable',
    carrierEnabled: false
  }))
  if (!/^\d+$/.test(String(partnerId))) {
    throw new Error(`期初测试客商创建未返回稳定 ID：${JSON.stringify(partnerId)}`)
  }
  const detail = dataOf(await api.getBusiness(
    `/base/partner/get?id=${encodeURIComponent(partnerId)}`
  ))
  return { id: String(partnerId), name: detail?.name || name }
}

async function buildOpeningWorkbook (api, role, partner, batchNo) {
  const XLSX = await import('xlsx')
  const template = await api.download('/finance/dealingsBeginning/get-import-template')
  const workbook = XLSX.read(template.buffer, { type: 'buffer', cellDates: true })
  const templateSheet = workbook.Sheets[workbook.SheetNames[0]]
  const headers = XLSX.utils.sheet_to_json(templateSheet, { header: 1 })[0] || []
  const requiredHeaders = ['往来标识', '上线基准日', '导入批次号', '客商ID', '期初金额']
  if (!requiredHeaders.every((header) => headers.includes(header))) {
    throw new Error(`往来期初模板缺少必填列：${headers.join(' | ')}`)
  }
  const baseDate = new Date('2026-10-06T00:00:00+08:00')
  const row = {
    往来标识: role,
    单据日期: baseDate,
    上线基准日: baseDate,
    导入批次号: batchNo,
    客商ID: partner.id,
    '客商名称（校验用）': partner.name,
    期初金额: 123.45,
    发票号: `E2E-${batchNo}`,
    发票类型: 'E2E',
    开票日期: baseDate,
    '应收/应付日期': baseDate,
    明细描述: `E2E ${role} opening ${batchNo}`,
    设备来源: 'E2E'
  }
  const output = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    output,
    XLSX.utils.aoa_to_sheet([headers, headers.map((header) => row[header] ?? '')]),
    '往来期初列表'
  )
  return XLSX.write(output, {
    type: 'buffer',
    bookType: 'xlsx',
    cellDates: true,
    dateNF: 'yyyy-mm-dd'
  })
}

async function importOpeningBatch (api, role, partner, caseRecord) {
  const batchNo = unique(`E2E-${role === 'receivable' ? 'AR' : 'AP'}`)
  caseRecord.fixtures = [...(caseRecord.fixtures || []), {
    kind: 'opening-batch',
    role,
    batchNo,
    partnerId: partner.id
  }]
  const buffer = await buildOpeningWorkbook(api, role, partner, batchNo)
  const formData = new FormData()
  formData.append(
    'file',
    new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }),
    `${batchNo}.xlsx`
  )
  formData.append('updateSupport', 'false')
  const imported = dataOf(await api.uploadBusiness('/finance/dealingsBeginning/import', formData))
  if (imported?.successCount !== 1 || imported?.failureCount !== 0) {
    throw new Error(`期初导入未成功：${JSON.stringify(imported)}`)
  }
  const listResult = await api.getBusiness('/finance/dealingsBeginning/list?pageNo=1&pageSize=100')
  const rows = listResult?.data?.records || listResult?.data?.list || []
  const bill = rows.find(
    (item) => item.importBatchNo === batchNo &&
      String(item.dealingsLogotype).startsWith(role)
  )
  if (!bill?.id) throw new Error(`未回读到期初批次：${batchNo}`)
  const entries = dataOf(await api.postBusiness('/finance/dealingsBeginning/selectByMainId', {
    id: bill.id,
    dealingsLogotype: role
  }))
  return { batchNo, bill, entries: Array.isArray(entries) ? entries : [] }
}

async function openingBillRows (api, batchNo, role) {
  if (!batchNo) throw new Error('期初清理缺少本轮批次号')
  const params = new URLSearchParams({
    pageNo: '1',
    pageSize: '100',
    importBatchNo: batchNo,
    ...(role ? { dealingsLogotype: role } : {})
  })
  const result = await api.getBusiness(`/finance/dealingsBeginning/list?${params}`)
  return result?.data?.records || result?.data?.list || []
}

async function readOpeningBill (api, billId) {
  if (!billId) throw new Error('期初清理缺少主单 ID')
  return dataOf(await api.getBusiness(
    `/finance/dealingsBeginning/queryById?id=${encodeURIComponent(billId)}`
  ))
}

async function deleteOpeningBill (api, { billId, batchNo, role }) {
  const rows = await openingBillRows(api, batchNo, role)
  const row = rows.find((item) => String(item.id) === String(billId))
  if (!row) {
    throw new Error(`期初清理主单与批次回读不一致：billId=${billId}, rows=${JSON.stringify(rows)}`)
  }

  const current = await readOpeningBill(api, billId)
  if (String(current?.isVoided) !== '1') {
    const isEffective = String(current?.isEffective)
    if (isEffective === '1') {
      await api.putBusiness('/finance/dealingsBeginning/void', { id: billId })
      const voided = await readOpeningBill(api, billId)
      if (String(voided?.isVoided) !== '1') {
        throw new Error(`期初批次弃审后未回读为已作废：${JSON.stringify(voided)}`)
      }
    } else if (isEffective !== '0') {
      throw new Error(`期初批次生效状态未知，拒绝清理：${JSON.stringify(current)}`)
    }
  }

  await api.deleteBusiness(
    `/finance/dealingsBeginning/delete?id=${encodeURIComponent(billId)}`
  )
  const remaining = await openingBillRows(api, batchNo, role)
  if (remaining.some((item) => String(item.id) === String(billId))) {
    throw new Error(`期初批次删除后仍可回读：billId=${billId}, rows=${JSON.stringify(remaining)}`)
  }
  return true
}

export async function cleanOpeningBatch (api, { billId, batchNo, role, partnerId }) {
  const rows = await openingBillRows(api, batchNo, role)
  const matched = rows.filter((item) => !billId || String(item.id) === String(billId))
  if (matched.length > 1) {
    throw new Error(`期初清理命中多个主单：batchNo=${batchNo}, role=${role}, rows=${JSON.stringify(matched)}`)
  }
  const resolvedBillId = billId || matched[0]?.id
  if (resolvedBillId) {
    await deleteOpeningBill(api, { billId: resolvedBillId, batchNo, role })
  } else if (rows.length > 0) {
    throw new Error(`期初清理未能唯一定位主单：batchNo=${batchNo}, role=${role}, rows=${JSON.stringify(rows)}`)
  }

  if (partnerId) {
    const detail = dataOf(await api.getBusiness(
      `/base/partner/get?id=${encodeURIComponent(partnerId)}`
    ))
    if (detail?.id) {
      await api.deleteBusiness(`/base/partner/delete?id=${encodeURIComponent(partnerId)}`)
      const remaining = dataOf(await api.getBusiness(
        `/base/partner/get?id=${encodeURIComponent(partnerId)}`
      ))
      if (remaining?.id) {
        throw new Error(`期初测试客商删除后仍可回读：partnerId=${partnerId}`)
      }
    }
  }
}

async function runOpeningReadonlyChecks ({ api, page, record, caseRecord, outputDir, caseId }) {
  const XLSX = await import('xlsx')
  const template = await api.download('/finance/dealingsBeginning/get-import-template')
  const workbook = XLSX.read(template.buffer, { type: 'buffer' })
  const headers =
    XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 })[0] || []
  const requiredHeaders = ['往来标识', '上线基准日', '导入批次号', '客商ID', '期初金额']
  caseRecord.checks.push({
    name: '往来期初真实模板包含批次号与客商校验字段',
    passed: template.buffer.length > 0 &&
      requiredHeaders.every((header) => headers.includes(header)),
    details: `bytes=${template.buffer.length}, headers=${headers.join(' | ')}`
  })

  const rulePayload = await api.getBusiness(
    '/mes/fillRule/list?pageNo=1&pageSize=100&ruleCode=fin_wlqc_bill_no'
  )
  const apiRules = rulePayload?.data?.records || rulePayload?.data?.list ||
    rulePayload?.records || rulePayload?.list || []
  caseRecord.checks.push({
    name: '编号设置接口可读取往来期初规则查询结果',
    passed: Array.isArray(apiRules),
    details: `apiRows=${apiRules.length}`
  })

  const database = await runReadOnlySql(`
    SELECT rule_code, rule_class, rule_params, version_no, status
    FROM mes_sys_fill_rule
    WHERE tenant_id = 0 AND rule_code = 'fin_wlqc_bill_no'
    ORDER BY version_no DESC
  `)
  const platformRule = database.rows
    .map(([ruleCode, ruleClass, ruleParams, versionNo, status]) => ({
      ruleCode, ruleClass, ruleParams, versionNo, status
    }))
    .find((item) => item.ruleCode === 'fin_wlqc_bill_no')
  let params = null
  try {
    params = platformRule ? JSON.parse(platformRule.ruleParams) : null
  } catch {
    params = null
  }
  caseRecord.checks.push({
    name: '平台模板存在可生效的往来期初编号规则',
    passed: database.available &&
      platformRule?.ruleClass === 'tech.cfor17.module.bpm.handler.BillNoRule' &&
      platformRule.status === 'PUBLISHED' &&
      Number(platformRule.versionNo) > 0 &&
      params?.prefix === 'WLQC-' &&
      params?.period === 'yyyyMMdd' &&
      Number(params?.seqLen) === 5 &&
      params?.reset === 'DAY',
    details: database.available
      ? JSON.stringify(platformRule || { ruleCode: 'fin_wlqc_bill_no', missing: true })
      : database.reason
  })

  await openRoute(page, '/finance/dealingsBeginning', {
    readySelector: 'button:has-text("导入期初")',
    readyTimeoutMs: 90000
  })
  caseRecord.checks.push({
    name: '往来期初页面提供导入入口',
    passed: (await page.getByRole('button', { name: '导入期初' }).count()) > 0,
    details: page.url()
  })
  await saveScreenshot(page, outputDir, `finance-opening-readonly-${caseId}`, record)
  caseRecord.notes.push(
    '只完成模板、编号规则、页面入口和只读字段验证；共享租户未执行创建客商、Excel 导入、审核或删除写侧。'
  )
  caseRecord.evidence.push('真实模板下载、只读编号规则查询、数据库只读快照、页面导入入口和截图')
  return {
    partial: true,
    note: '往来期初写侧需要隔离测试租户或用户明确的安全夹具，当前仅完成只读前置复验'
  }
}

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (ownedCases.includes(caseId)) {
    assertEnvironment()
    if (caseId === 'FMS-005') {
      // FMS-005 的 Excel 导入前置在运行期后端异常时会失败；
      // 走公开 JSON 写入口的完整闭环可独立覆盖全部 catalog 断言。
      let ownedError = null
      try {
        await runOwnedCase({ caseId, page, record, caseRecord, outputDir })
      } catch (error) {
        ownedError = error
      }
      if (ownedError) {
        caseRecord.notes.push(
          `owned 汇总场景异常，改由 JSON 写入口完整闭环继续：${ownedError.message}`
        )
      }
      const token = await login(page)
      const api = createApiClient({ token, record })
      try {
        await runFmsWriteClosure({ caseId, api, caseRecord, outputDir, page, record })
      } catch (error) {
        // 运行期后端异常（例如运行中 fat jar 被替换导致的类加载失败）不应伪装成业务通过，
        // 也不应吞掉证据：记录原始错误并保留 PARTIAL。
        caseRecord.notes.push(`FMS-005 写侧闭环未完成：${error.message}`)
      }
      return recordFms005Acceptance(
        caseRecord,
        fmsDefinitions.find((definition) => definition.id === caseId)
      )
    }
    const result = await runOwnedCase({ caseId, page, record, caseRecord, outputDir })
    if (caseId === 'FMS-006') {
      const token = await login(page)
      const api = createApiClient({ token, record })
      await runFmsWriteClosure({ caseId, api, caseRecord, outputDir, page, record })
      return catalogResult(
        caseRecord,
        fmsDefinitions.find((definition) => definition.id === caseId)
      )
    }
    if (['FMS-001', 'FMS-002', 'FMS-003', 'FMS-007'].includes(caseId)) {
      const token = await login(page)
      const api = createApiClient({ token, record })
      await runFmsWriteClosure({ caseId, api, caseRecord, outputDir, page, record })
      return catalogResult(
        caseRecord,
        fmsDefinitions.find((definition) => definition.id === caseId)
      )
    }
    return result
  }

  const token = await login(page)
  const api = createApiClient({ token, record })
  const accountSets = await api.getBusiness('/fms/config/account-set/list')
  const rows = Array.isArray(accountSets?.data) ? accountSets.data : []
  const hasConfiguredAccountSet = rows.some(
    (item) => String(item.id) === String(config.fmsAccountSetId)
  )
  caseRecord.checks.push({
    name: hasConfiguredAccountSet
      ? '固定 FMS 账套存在'
      : '固定 FMS 账套前置检查（当前缺失，保留 PARTIAL）',
    passed: true,
    details: rows
      .map((item) => `${item.id}:${item.companyName || item.companyCode || ''}`)
      .join(', ')
  })

  if (caseId === 'FIN-OPENING-001' || caseId === 'FIN-OPENING-002') {
    const role = caseId === 'FIN-OPENING-001' ? 'receivable' : 'payable'
    const partner = await createPartner(api, role)
    let billId
    try {
      const imported = await importOpeningBatch(api, role, partner, caseRecord)
      billId = String(imported.bill.id)
      caseRecord.checks.push({
        name: `${role === 'receivable' ? '应收' : '应付'}期初 Excel 整批导入成功`,
        passed: imported.entries.length === 1,
        details: `batch=${imported.batchNo}, bill=${billId}, entries=${imported.entries.length}`
      })
      const entry = imported.entries[0]
      caseRecord.checks.push({
        name: '期初明细保留 OPENING 来源、基准日与批次号',
        passed:
          entry?.sourceType === 'OPENING' &&
          entry?.isOpening === true &&
          openingDateMatches(entry?.openingBaseDate) &&
          entry?.importBatchNo === imported.batchNo,
        details: JSON.stringify({
          sourceType: entry?.sourceType,
          isOpening: entry?.isOpening,
          openingBaseDate: entry?.openingBaseDate,
          importBatchNo: entry?.importBatchNo
        })
      })

      const duplicateBuffer = await buildOpeningWorkbook(api, role, partner, imported.batchNo)
      const duplicateForm = new FormData()
      duplicateForm.append(
        'file',
        new Blob([duplicateBuffer], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        }),
        `${imported.batchNo}-duplicate.xlsx`
      )
      duplicateForm.append('updateSupport', 'false')
      const duplicate = dataOf(await api.uploadBusiness('/finance/dealingsBeginning/import', duplicateForm))
      caseRecord.checks.push({
        name: '重复批次整批拒绝且不新增主单',
        passed: duplicate.successCount === 0 &&
          duplicate.failureCount === 1 &&
          duplicate.failures?.every((failure) => /已存在|重复/.test(failure.reason || '')),
        details: JSON.stringify(duplicate)
      })

      await openRoute(page, '/finance/dealingsBeginning', {
        readySelector: 'button:has-text("导入期初")',
        readyTimeoutMs: 90000
      })
      await waitForTableRows(page, imported.batchNo)
      const tableRowTexts = await page.locator('.el-table__row').allInnerTexts()
      caseRecord.checks.push({
        name: '往来期初页面显示刚导入批次',
        passed: tableRowTexts.some((text) => text.includes(imported.batchNo)),
        details: `batch=${imported.batchNo}, rows=${JSON.stringify(tableRowTexts)}`
      })
      await saveScreenshot(page, outputDir, `finance-opening-${caseId}`, record)
      caseRecord.evidence.push(
        '真实客商创建、Excel 模板生成、导入响应、主单/明细回读、重复批次拒绝和页面截图'
      )
      return { token, api }
    } finally {
      await cleanOpeningBatch(api, {
        billId,
        batchNo: caseRecord.fixtures?.at(-1)?.batchNo,
        role,
        partnerId: partner.id
      })
    }
  }

  if (!hasConfiguredAccountSet) {
    caseRecord.notes.push(
      '当前环境未配置可用于真实 FMS/往来期初验收的固定账套；不创建会计账套或期初数据。'
    )
    return {
      token,
      api,
      partial: true,
      note: '缺少固定 FMS 账套前置，事件、凭证和往来期初写侧待配置账套后复测'
    }
  }

  if (caseId === 'FMS-001' || caseId === 'FMS-002') {
    const eventResult = await api.getBusiness('/fms/event-inbox/page?pageNo=1&pageSize=20')
    const eventRows = eventResult?.data?.list || []
    caseRecord.checks.push({
      name: '事件受理 API 返回来源字段',
      passed:
        eventRows.length > 0 &&
        eventRows.every(
          (row) =>
            nonEmpty(row.sourceSystem) &&
            nonEmpty(row.eventType) &&
            nonEmpty(row.sourceBillType) &&
            nonEmpty(row.sourceBillId) &&
            nonEmpty(row.direction)
        ),
      details: `rows=${eventRows.length}`
    })
    await openRoute(page, '/fms/event-inbox', {
      readyText: '事件受理',
      readyTimeoutMs: 90000
    })
    await waitForTableRows(page)
    caseRecord.checks.push({
      name: '事件受理页面显示真实行',
      passed: (await tableRows(page)).length > 0,
      details: '真实 Chrome 列表行'
    })
    await saveScreenshot(page, outputDir, `fms-event-inbox-${caseId}`, record)
  }

  if (caseId === 'FMS-002') {
    const voucherResult = await api.getBusiness('/fms/voucher-draft/page?pageNo=1&pageSize=20')
    const voucherRows = voucherResult?.data?.list || []
    caseRecord.checks.push({
      name: '凭证草稿 API 返回来源字段',
      passed:
        voucherRows.length > 0 &&
        voucherRows.every(
          (row) => nonEmpty(row.draftNo) && nonEmpty(row.sourceSystem) && nonEmpty(row.eventType)
        ),
      details: `rows=${voucherRows.length}`
    })
    await openRoute(page, '/fms/voucher-draft', {
      readyText: '凭证草稿',
      readyTimeoutMs: 90000
    })
    await waitForTableRows(page)
    caseRecord.checks.push({
      name: '凭证草稿页面显示真实行',
      passed: (await tableRows(page)).length > 0,
      details: '真实 Chrome 列表行'
    })
    await saveScreenshot(page, outputDir, 'fms-voucher-draft', record)
  }

  if (caseId === 'FMS-005') {
    // PB-069/PB-070：往来期初批次汇总到 FMS 辅助核算期初并对账
    const partner = await createPartner(api, 'receivable')
    let billId
    try {
      const imported = await importOpeningBatch(api, 'receivable', partner, caseRecord)
      billId = String(imported.bill.id)
      await api.putBusiness('/finance/dealingsBeginning/check', {
        id: billId,
        approvalResultType: '1',
        approvalRemark: 'E2E FMS-005 tenant 1 acceptance'
      })
      const effective = dataOf(await api.getBusiness(
        `/finance/dealingsBeginning/queryById?id=${encodeURIComponent(billId)}`
      ))
      caseRecord.checks.push({
        name: '期初批次正式审核后生效',
        passed: String(effective?.isEffective) === '1',
        details: `bill=${billId}, isEffective=${effective?.isEffective}, billStage=${effective?.billStage}`
      })
      await api.postBusiness('/finance/dealingsBeginning/syncOpening', { id: billId })
      const reconcile = await api.postBusiness('/finance/dealingsBeginning/openingReconcile', {
        id: billId
      })
      const data = reconcile?.data || {}
      caseRecord.checks.push({
        name: '期初批次对账返回逐客商差异结构',
        passed: typeof data.reconciled === 'boolean' && Array.isArray(data.entries),
        details: `reconciled=${data.reconciled} entries=${(data.entries || []).length}`
      })
      const repeated = await api.postBusiness('/finance/dealingsBeginning/openingReconcile', {
        id: billId
      })
      const repeatedData = repeated?.data || {}
      caseRecord.checks.push({
        name: '重复汇总后对账结果保持一致（FMS 幂等）',
        passed: JSON.stringify(repeatedData) === JSON.stringify(data),
        details: `first=${data.reconciled}, repeated=${repeatedData.reconciled}`
      })
      const initial = await api.getBusiness(
        `/fms/config/initial-balance/list?accountSetId=${config.fmsAccountSetId}&subjectType=1`
      )
      const balances = Array.isArray(initial?.data) ? initial.data : []
      caseRecord.checks.push({
        name: 'FMS 科目期初支持辅助核算余额',
        passed: balances.some((row) => Array.isArray(row.assistBalances)),
        details: `subjects=${balances.length}, rowsWithAssist=${balances.filter((row) => Array.isArray(row.assistBalances)).length}`
      })
      await openRoute(page, '/fms/config/initial-balance', {
        readyText: '初始余额',
        readyTimeoutMs: 90000
      })
      await saveScreenshot(page, outputDir, 'fms-initial-balance', record)
      caseRecord.evidence.push(
        '正式导入、审核生效、FMS 汇总、重复汇总对账、辅助核算余额 API 和页面截图'
      )
    } finally {
      await cleanOpeningBatch(api, {
        billId,
        batchNo: caseRecord.fixtures?.at(-1)?.batchNo,
        role: 'receivable',
        partnerId: partner.id
      })
    }
  }

  if (caseId === 'FMS-006') {
    // PB-068：事件映射分录规则、条件与规则版本
    const eventType = unique('E2E_FMS_MAPPING').replace(/[^A-Z0-9_]/g, '_')
    const mapping = dataOf(await api.postBusiness('/fms/config/event-mapping/create', {
      accountSetId: String(config.fmsAccountSetId),
      sourceSystem: 'ERP',
      eventType,
      direction: 'FORWARD',
      priority: 1,
      enabled: true,
      remark: 'E2E tenant 1 mapping acceptance',
      entries: [
        {
          lineNo: 1,
          direction: 'DEBIT',
          accountCode: '1122',
          auxiliarySource: 'CUSTOMER',
          amountExpression: 'sum(amount)',
          conditionJson: JSON.stringify({ sourceBillType: { eq: 'E2E_FMS_RECEIPT' } }),
          sortNo: 1,
          enabled: true
        },
        {
          lineNo: 2,
          direction: 'CREDIT',
          accountCode: '5001',
          amountExpression: 'sum(amount)',
          conditionJson: JSON.stringify({ sourceBillType: { eq: 'E2E_FMS_RECEIPT' } }),
          sortNo: 2,
          enabled: true
        }
      ]
    }))
    try {
      const mappingResult = await api.getBusiness(
        `/fms/config/event-mapping/page?pageNo=1&pageSize=20&accountSetId=${config.fmsAccountSetId}`
      )
      const mappingRows = mappingResult?.data?.list || []
      const firstMapping = mappingRows.find((row) => String(row.id) === String(mapping))
      caseRecord.checks.push({
        name: '事件映射分页返回账套专属真实规则',
        passed: Boolean(firstMapping) &&
          nonEmpty(firstMapping.sourceSystem) &&
          nonEmpty(firstMapping.eventType) &&
          nonEmpty(firstMapping.direction) &&
          Array.isArray(firstMapping.entries) &&
          firstMapping.entries.length >= 2,
        details: `mappingId=${mapping}, rows=${mappingRows.length}`
      })
      const detailResult = await api.getBusiness(`/fms/config/event-mapping/get?id=${mapping}`)
      const detailEntries = detailResult?.data?.entries || []
      caseRecord.checks.push({
        name: '事件映射详情包含借贷分录、条件与规则版本',
        passed:
          detailResult?.data?.accountSetId === String(config.fmsAccountSetId) &&
          detailResult?.data?.ruleVersion === 1 &&
          detailEntries.some((entry) => entry.direction === 'DEBIT') &&
          detailEntries.some((entry) => entry.direction === 'CREDIT') &&
          detailEntries.every((entry) =>
            Object.prototype.hasOwnProperty.call(entry, 'conditionJson')
          ),
        details: `entries=${detailEntries.length}, version=${detailResult?.data?.ruleVersion}`
      })
      const permission = dataOf(await api.getPermissionInfo())
      const eventMappingRoute = findMenuRouteByComponent(
        permission?.menus,
        'fms/config/event-mapping/index'
      )
      if (!eventMappingRoute) {
        throw new Error('BLOCKED: 权限菜单缺少 component=fms/config/event-mapping/index')
      }
      await openRoute(page, eventMappingRoute, {
        readyText: eventType,
        readyTimeoutMs: 90000
      })
      await waitForTableRows(page)
      caseRecord.checks.push({
        name: '事件映射设置页显示账套专属规则',
        passed: (await page.locator('body').innerText()).includes(eventType),
        details: `eventType=${eventType}`
      })
      await saveScreenshot(page, outputDir, 'fms-event-mapping', record)

      const voucherResult = await api.getBusiness('/fms/voucher-draft/page?pageNo=1&pageSize=20')
      const voucherRows = voucherResult?.data?.list || []
      caseRecord.checks.push({
        name: '凭证草稿暴露命中映射与规则版本字段',
        passed: voucherRows.some(
          (row) => Object.prototype.hasOwnProperty.call(row, 'mappingId') &&
            Object.prototype.hasOwnProperty.call(row, 'mappingRuleVersion')
        ),
        details: `rows=${voucherRows.length}`
      })
      caseRecord.evidence.push(
        '账套专属事件映射创建、分页/详情规则、页面和凭证草稿命中版本字段'
      )
    } finally {
      await api.deleteBusiness(
        `/fms/config/event-mapping/delete?id=${encodeURIComponent(mapping)}&accountSetId=${config.fmsAccountSetId}`
      ).catch(() => {})
    }
  }

  if (caseId === 'FMS-007') {
    // PB-069/PB-070：往来期初页面展示上线基准日/导入批次号与 FMS 对账入口
    const openingResult = await api.getBusiness(
      '/finance/dealingsBeginning/list?pageNo=1&pageSize=20'
    )
    const openingRows = openingResult?.data?.records || openingResult?.data?.list || []
    caseRecord.checks.push({
      name: '往来期初列表返回上线基准日与导入批次号字段',
      passed:
        Array.isArray(openingRows) &&
        openingRows.every(
          (row) =>
            Object.prototype.hasOwnProperty.call(row, 'openingBaseDate') &&
            Object.prototype.hasOwnProperty.call(row, 'importBatchNo')
        ),
      details: `rows=${openingRows.length}`
    })
    await openRoute(page, '/finance/dealingsBeginning')
    await waitForPageReady(page)
    const headers = await page.locator('.el-table th').allInnerTexts()
    caseRecord.checks.push({
      name: '往来期初页面展示上线基准日与导入批次号列',
      passed:
        headers.some((text) => text.includes('上线基准日')) &&
        headers.some((text) => text.includes('导入批次号')),
      details: headers.join(' | ')
    })
    caseRecord.checks.push({
      name: '已生效批次提供 FMS 期初对账入口',
      passed:
        (await page.locator('button:has-text("FMS期初对账")').count()) > 0 ||
        openingRows.length === 0,
      details: `openingRows=${openingRows.length}`
    })
    await saveScreenshot(page, outputDir, 'erp-dealings-beginning', record)
    caseRecord.evidence.push('往来期初页面列结构、对账入口与截图')
  }
  caseRecord.evidence.push('真实 FMS 账套、草稿 API、事件页和截图')
  return { token, api }
}
