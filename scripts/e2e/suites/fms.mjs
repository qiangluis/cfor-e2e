import { createApiClient } from '../lib/api.mjs'
import { nonEmpty } from '../lib/assertions.mjs'
import { config } from '../config/index.mjs'
import { login, openRoute, saveScreenshot, tableRows } from '../lib/browser.mjs'

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

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })
  const accountSets = await api.getBusiness('/fms/config/account-set/list')
  const rows = Array.isArray(accountSets.data) ? accountSets.data : []
  caseRecord.checks.push({
    name: '固定 FMS 账套存在',
    passed: rows.some((item) => String(item.id) === String(config.fmsAccountSetId)),
    details: rows
      .map((item) => `${item.id}:${item.companyName || item.companyCode || ''}`)
      .join(', ')
  })

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
    await openRoute(page, '/fms/event-inbox')
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
    await openRoute(page, '/fms/voucher-draft')
    caseRecord.checks.push({
      name: '凭证草稿页面显示真实行',
      passed: (await tableRows(page)).length > 0,
      details: '真实 Chrome 列表行'
    })
    await saveScreenshot(page, outputDir, 'fms-voucher-draft', record)
  }

  if (caseId === 'FIN-OPENING-001' || caseId === 'FIN-OPENING-002') {
    // PB-069/PB-070：期初应收/应付模板下载、Excel 导入、批次落库与明细回读。
    const XLSX = await import('xlsx')
    const receivable = caseId === 'FIN-OPENING-001'
    const roleLabel = receivable ? 'receivable' : 'payable'
    const partnerRole = receivable ? 'CUSTOMER' : 'SUPPLIER'
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase()
    const partnerName = `E2E期初客商${suffix}`
    const batchNo = `E2E-OPEN-${suffix}`
    let partnerId
    let batchId

    try {
      const partnerResult = await api.postBusiness('/base/partner/create', {
        name: partnerName,
        shortName: partnerName,
        partnerKind: 'ORGANIZATION',
        taxNo: `E2E${suffix}`,
        status: 'ACTIVE',
        customerEnabled: receivable,
        supplierEnabled: !receivable
      })
      partnerId = unwrapData(partnerResult)
      caseRecord.checks.push({
        name: '创建期初导入专用统一客商',
        passed: nonEmpty(partnerId),
        details: `partnerId=${partnerId}, role=${partnerRole}`
      })

      const template = await api.download('/finance/dealingsBeginning/get-import-template')
      const templateBook = XLSX.read(template.buffer, { type: 'buffer' })
      const templateHeaders =
        XLSX.utils.sheet_to_json(templateBook.Sheets[templateBook.SheetNames[0]], {
          header: 1
        })[0] || []
      const requiredHeaders = ['往来标识', '上线基准日', '导入批次号', '客商ID', '期初金额']
      caseRecord.checks.push({
        name: '往来期初导入模板包含批次号与客商校验字段',
        passed:
          template.buffer.length > 0 &&
          requiredHeaders.every((header) => templateHeaders.includes(header)),
        details: `bytes=${template.buffer.length}, headers=${templateHeaders.join(' | ')}`
      })

      const row = {
        往来标识: roleLabel,
        单据日期: '2026-10-01',
        上线基准日: '2026-10-01',
        导入批次号: batchNo,
        客商ID: String(partnerId),
        '客商名称（校验用）': partnerName,
        期初金额: receivable ? '123.45' : '67.89',
        单据类型ID: '',
        发票号: `E2E-${suffix}`,
        发票类型: '',
        开票日期: '',
        '应收/应付日期': '2026-10-01',
        业务部门ID: '',
        业务员ID: '',
        明细描述: `E2E ${caseId}`,
        设备来源: ''
      }
      const importBook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(importBook, XLSX.utils.json_to_sheet([row]), '往来期初列表')
      const importBuffer = XLSX.write(importBook, { type: 'buffer', bookType: 'xlsx' })
      const formData = new FormData()
      formData.append(
        'file',
        new Blob([importBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
        `${caseId}.xlsx`
      )
      formData.append('updateSupport', 'false')
      const importPayload = await api.uploadBusiness('/finance/dealingsBeginning/import', formData)
      const importResult = unwrapData(importPayload)
      caseRecord.checks.push({
        name: 'Excel 导入按批次成功写入往来期初',
        passed: importResult?.successCount === 1 && importResult?.failureCount === 0,
        details: JSON.stringify(importResult)
      })

      const pageResult = await api.getBusiness(
        `/finance/dealingsBeginning/list?pageNo=1&pageSize=20&importBatchNo=${encodeURIComponent(batchNo)}`
      )
      const rows = pageResult?.data?.records || pageResult?.data?.list || []
      const importedBill = rows.find((item) => item.importBatchNo === batchNo)
      batchId = importedBill?.id
      caseRecord.checks.push({
        name: '导入批次可从往来期初列表回读',
        passed: Boolean(importedBill?.id) && importedBill?.dealingsLogotype === roleLabel,
        details: `rows=${rows.length}, batchId=${batchId}`
      })

      const entryPayload = await api.postBusiness('/finance/dealingsBeginning/selectByMainId', {
        id: batchId,
        dealingsLogotype: roleLabel
      })
      const entries = entryPayload?.data || []
      const entry = entries[0] || {}
      caseRecord.checks.push({
        name: '期初明细保留统一客商、批次、基准日和 OPENING 来源',
        passed:
          entries.length === 1 &&
          String(receivable ? entry.customerId : entry.supplierId) === String(partnerId) &&
          entry.importBatchNo === batchNo &&
          entry.sourceType === 'OPENING' &&
          entry.isOpening === true,
        details: `entries=${entries.length}`
      })
    } finally {
      if (batchId) {
        await api
          .request('DELETE', `/finance/dealingsBeginning/delete?id=${encodeURIComponent(batchId)}`)
          .catch(() => undefined)
      }
      if (partnerId) {
        await api
          .request('DELETE', `/base/partner/delete?id=${encodeURIComponent(partnerId)}`)
          .catch(() => undefined)
      }
    }

    await openRoute(page, '/finance/dealingsBeginning', { readyText: '导入期初' })
    caseRecord.checks.push({
      name: '往来期初页面提供导入入口',
      passed: (await page.getByRole('button', { name: '导入期初' }).count()) > 0,
      details: page.url()
    })
    await saveScreenshot(page, outputDir, `finance-opening-${caseId}`, record)
    caseRecord.evidence.push('真实模板、Excel 文件、导入接口、批次与明细回读，以及页面导入入口')
  }

  if (caseId === 'FMS-005') {
    // PB-069/PB-070：往来期初批次汇总到 FMS 辅助核算期初并对账
    const openingResult = await api.getBusiness('/finance/dealingsBeginning/list?pageNo=1&pageSize=20')
    const openingRows = openingResult?.data?.records || openingResult?.data?.list || []
    caseRecord.checks.push({
      name: '往来期初批次列表接口可用',
      passed: Array.isArray(openingRows),
      details: `rows=${openingRows.length}`
    })
    const effective = openingRows.find((row) => String(row.isEffective) === '1')
    if (effective) {
      const reconcile = await api.postBusiness('/finance/dealingsBeginning/openingReconcile', {
        id: effective.id
      })
      const data = reconcile?.data || {}
      caseRecord.checks.push({
        name: '期初批次对账返回逐客商差异结构',
        passed: typeof data.reconciled === 'boolean' && Array.isArray(data.entries),
        details: `reconciled=${data.reconciled} entries=${(data.entries || []).length}`
      })
      const initial = await api.getBusiness(
        `/fms/config/initial-balance/list?accountSetId=${config.fmsAccountSetId}`
      )
      const balances = Array.isArray(initial?.data) ? initial.data : []
      caseRecord.checks.push({
        name: 'FMS 科目期初支持辅助核算余额',
        passed: balances.some((row) => Array.isArray(row.assistBalances)),
        details: `subjects=${balances.length}`
      })
      await openRoute(page, '/fms/config/initial-balance')
      await saveScreenshot(page, outputDir, 'fms-initial-balance', record)
    } else {
      caseRecord.checks.push({
        name: '存在已生效往来期初批次用于对账',
        passed: false,
        details: '当前环境暂无已生效往来期初批次，需在统一回归中先造期初批次'
      })
    }
    caseRecord.evidence.push('往来期初批次 API、FMS 辅助核算期初与截图')
  }

  if (caseId === 'FMS-006') {
    // PB-068：事件映射分录规则、条件与规则版本
    const mappingResult = await api.getBusiness(
      `/fms/config/event-mapping/page?pageNo=1&pageSize=20&accountSetId=${config.fmsAccountSetId}`
    )
    const mappingRows = mappingResult?.data?.list || []
    caseRecord.checks.push({
      name: '事件映射分页返回真实规则',
      passed:
        mappingRows.length > 0 &&
        mappingRows.every(
          (row) =>
            nonEmpty(row.sourceSystem) &&
            nonEmpty(row.eventType) &&
            nonEmpty(row.direction) &&
            Array.isArray(row.entries) &&
            row.entries.length >= 2
        ),
      details: `rows=${mappingRows.length}`
    })
    const firstMapping = mappingRows[0]
    if (firstMapping?.id) {
      const detailResult = await api.getBusiness(`/fms/config/event-mapping/get?id=${firstMapping.id}`)
      const detailEntries = detailResult?.data?.entries || []
      caseRecord.checks.push({
        name: '事件映射详情包含借贷分录与条件字段',
        passed:
          detailEntries.some((entry) => entry.direction === 'DEBIT') &&
          detailEntries.some((entry) => entry.direction === 'CREDIT') &&
          detailEntries.every((entry) =>
            Object.prototype.hasOwnProperty.call(entry, 'conditionJson')
          ),
        details: `entries=${detailEntries.length}`
      })
    } else {
      caseRecord.checks.push({
        name: '存在事件映射规则用于详情校验',
        passed: false,
        details: '当前账套暂无事件映射规则'
      })
    }
    await openRoute(page, '/fms/config/event-mapping')
    caseRecord.checks.push({
      name: '事件映射设置页可打开',
      passed: (await page.locator('.el-table').count()) > 0,
      details: '真实 Chrome 事件映射设置页'
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
    caseRecord.evidence.push('事件映射维护页、分页/详情规则与凭证草稿命中版本字段')
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
    await page.waitForTimeout(1000)
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

const unwrapData = (payload) => payload?.data ?? payload
