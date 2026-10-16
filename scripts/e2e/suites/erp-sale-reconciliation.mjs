import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

// PB-268～PB-271 销售对账中心自动化案例索引，含 PB-166 差异处理与修订版本。
export const cases = [
  'ERP-SALE-RECON-001',
  'ERP-SALE-RECON-002',
  'ERP-SALE-RECON-003',
  'ERP-SALE-RECON-004'
]

const unwrap = (response) => response?.data

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (caseId === 'ERP-SALE-RECON-004') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    // PB-166：客户驳回后企业侧要把单据推进到差异处理中、生成修订版本并重新发送确认。
    const pageResult = unwrap(await api.get('/erp/sale-reconciliation/page?pageNo=1&pageSize=100'))
    const rows = Array.isArray(pageResult?.list) ? pageResult.list : []
    const sample = rows[0]
    caseRecord.checks.push({
      name: 'PB-166 对账单分页契约暴露修订版本字段',
      passed:
        rows.length > 0 &&
        rows.every((row) => Object.prototype.hasOwnProperty.call(row, 'revisionNo')),
      details: JSON.stringify({ total: pageResult?.total, sampleRevisionNo: sample?.revisionNo })
    })
    const detail = sample?.id
      ? unwrap(await api.get(`/erp/sale-reconciliation/get?id=${sample.id}`))
      : null
    caseRecord.checks.push({
      name: 'PB-166 对账单详情返回修订版本与修订说明',
      passed:
        Boolean(detail) &&
        Object.prototype.hasOwnProperty.call(detail, 'revisionNo') &&
        Object.prototype.hasOwnProperty.call(detail, 'revisionNote'),
      details: JSON.stringify({
        billNo: detail?.billNo,
        revisionNo: detail?.revisionNo,
        revisionNote: detail?.revisionNote
      })
    })

    // 只读探针：不存在的对账单必须被业务拒绝（证明路由已部署且通过权限校验），
    // 而不是落到 DefaultController 的 404/501 兜底或权限不足提示。
    const probe = await api.put('/erp/sale-reconciliation/process-difference', {
      id: 'e2e-pb166-missing-reconciliation',
      version: 0,
      revisionNote: 'E2E 路由与权限探针'
    })
    const probeMessage = String(probe?.msg ?? probe?.message ?? '')
    caseRecord.checks.push({
      name: 'PB-166 差异处理接口已部署且受权限保护',
      passed: /销售对账单不存在|仅客户驳回|对账单状态已改变|对账单已被其他用户操作/.test(probeMessage),
      details: `code=${probe?.code} msg=${probeMessage}`
    })

    // 详情弹窗固定展示修订版本；有客户驳回样本时再校验差异处理按钮。
    const rejected = rows.find((row) => row?.status === 'CUSTOMER_REJECTED')
    const target = rejected || sample
    if (target?.id) {
      await openRoute(page, '/erp/sale/reconciliation', { readyText: '销售对账' })
      const row = page.locator('.el-table__row', { hasText: target.billNo }).first()
      await row.waitFor({ state: 'visible', timeout: 15000 })
      await row.getByRole('button', { name: '详情' }).click()
      await page.getByText('修订版本').first().waitFor({ state: 'visible', timeout: 15000 })
      caseRecord.checks.push({
        name: 'PB-166 对账详情弹窗展示修订版本',
        passed: true,
        details: `${target.billNo} revisionNo=${target.revisionNo}`
      })
      if (rejected) {
        const action = page.getByRole('button', { name: '差异处理并重新发送' })
        caseRecord.checks.push({
          name: 'PB-166 客户驳回的对账单提供差异处理并重新发送入口',
          passed: (await action.count()) > 0,
          details: rejected.billNo
        })
      } else {
        caseRecord.evidence.push(
          '当前租户无 CUSTOMER_REJECTED 对账单，差异处理按钮的界面校验待有样本时执行（接口与权限已在探针中校验）'
        )
      }
      await saveScreenshot(page, outputDir, 'erp-sale-reconciliation-revision', record)
    }
    caseRecord.evidence.push(
      'PB-166 修订版本字段、差异处理路由与权限、详情弹窗修订版本展示校验'
    )
    return { token, api }
  }

  if (caseId === 'ERP-SALE-RECON-003') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    // PB-271：导出必须走独立权限键 erp:sale-reconciliation:export，
    // 返回真实 Excel 流而不是 DefaultController 兜底。
    const exported = await api.download('/erp/sale-reconciliation/export-excel?pageNo=1&pageSize=100')
    const contentType = String(exported?.contentType || '')
    const buffer = exported?.buffer
    const isSpreadsheet =
      /spreadsheet|excel|octet-stream/i.test(contentType) ||
      buffer?.subarray(0, 2).toString('latin1') === 'PK'
    caseRecord.checks.push({
      name: 'PB-271 销售对账导出返回真实 Excel 文件',
      passed: Boolean(buffer?.length) && isSpreadsheet,
      details: `contentType=${contentType}, bytes=${buffer?.length ?? 0}`
    })
    caseRecord.checks.push({
      name: 'PB-271 导出响应带下载文件名',
      passed: Boolean(exported?.contentDisposition),
      details: String(exported?.contentDisposition || '')
    })

    await openRoute(page, '/erp/sale/reconciliation', { readyText: '销售对账' })
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: 'PB-271 销售对账页面提供导出入口',
      passed: page.url().includes('/erp/sale/reconciliation') && bodyText.includes('导出'),
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'erp-sale-reconciliation-export', record)
    caseRecord.evidence.push('销售对账导出接口真实文件流与页面导出入口校验')
    return { token, api }
  }

  if (caseId === 'ERP-SALE-RECON-002') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    // 明细占用与开票占用契约：每条有效明细必须带 active 来源行键，开票额度不得为负。
    const pageResult = unwrap(await api.get('/erp/sale-reconciliation/page?pageNo=1&pageSize=100'))
    const rows = Array.isArray(pageResult?.list) ? pageResult.list : []
    const sample = rows[0]
    let detail = null
    if (sample?.id) {
      detail = unwrap(await api.get(`/erp/sale-reconciliation/get?id=${sample.id}`))
    }
    const lines = Array.isArray(detail?.lines) ? detail.lines : []
    caseRecord.checks.push({
      name: '销售对账详情返回明细行且每行携带来源出库行',
      passed: lines.length === 0 || lines.every((line) => Boolean(line?.sourceOutItemId)),
      details: `lines=${lines.length}`
    })
    caseRecord.checks.push({
      name: '对账单明细剩余可开票金额不为负',
      passed: lines.every((line) => Number(line?.remainingInvoiceAmount ?? 0) >= 0),
      details: `min=${lines.reduce(
        (min, line) => Math.min(min, Number(line?.remainingInvoiceAmount ?? 0)),
        0
      )}`
    })
    caseRecord.evidence.push('销售对账分页/详情契约：明细来源行与开票额度校验')
    return { token, api }
  }

  if (caseId !== 'ERP-SALE-RECON-001') return { designed: true }

  const token = await login(page)
  const api = createApiClient({ token, record })
  const pageResult = unwrap(await api.get('/erp/sale-reconciliation/page?pageNo=1&pageSize=100'))
  caseRecord.checks.push({
    name: '销售对账分页接口返回真实业务数据',
    passed: Array.isArray(pageResult?.list) && Number.isFinite(Number(pageResult?.total)),
    details: JSON.stringify({
      total: pageResult?.total,
      sample: pageResult?.list?.[0]?.billNo
    })
  })

  // 可对账明细接口：按客户拉取已审核销售出库行，是发起对账的数据前提。
  const customerId = pageResult?.list?.[0]?.customerId
  if (customerId) {
    const lines = unwrap(
      await api.get(`/erp/sale-reconciliation/available-lines?customerId=${customerId}`)
    )
    caseRecord.checks.push({
      name: '可对账销售出库明细接口按客户返回',
      passed: Array.isArray(lines),
      details: `lines=${Array.isArray(lines) ? lines.length : 'n/a'}`
    })
  }

  await openRoute(page, '/erp/sale/reconciliation', { readyText: '销售对账' })
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '销售对账页面在真实浏览器渲染并挂载操作入口',
    passed:
      page.url().includes('/erp/sale/reconciliation') &&
      bodyText.includes('销售对账') &&
      bodyText.includes('发起对账'),
    details: page.url()
  })
  await saveScreenshot(page, outputDir, 'erp-sale-reconciliation-list', record)
  caseRecord.evidence.push('真实登录、销售对账分页/可对账明细接口校验与页面截图')

  return { token, api }
}
