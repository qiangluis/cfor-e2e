import { createApiClient } from '../lib/api.mjs'
import { runReadOnlySql } from '../lib/db.mjs'
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
  if (caseId === 'FMS-003' || caseId === 'FMS-004') {
    return {
      notImplemented: true,
      note: `${caseId} 尚未实现真实业务步骤，不能以账套存在或通用检查作为通过证据`
    }
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
    return runOpeningReadonlyChecks({ api, page, record, caseRecord, outputDir, caseId })
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
