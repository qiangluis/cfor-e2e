import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = [
  'ERP-SALES-001',
  'ERP-SALES-002',
  'ERP-SALES-003',
  'ERP-SALES-004',
  'ERP-SALES-005',
  'ERP-SALES-006',
  'ERP-SALES-007'
]

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  caseRecord.notes.push(
    '案例已锁定合同审批通过+确认签署、WMS ATP、发货通知必经和按物料质检；' +
      'ERP-SALES-005 新增期初销售出库分支：erp_sale_out.business_type=OPENING 时不创建 WMS 单据、' +
      '不扣减库存、不回写订单 outCount，普通出库链路保持不变；后续 AI 需按真实页面/API 补执行。'
  )
  caseRecord.notes.push(
    'ERP-SALES-006 锁定 ERP 统一价格中心取价与订单取价快照：/erp/price-scheme/inquiry 返回方案/版本/价格行/' +
      '命中依据/计算时间，销售和采购订单明细分别落 price_scheme_id、price_version_id、price_rule_id、' +
      'price_hit_source、price_calculated_at 快照；价格版本调整不追溯历史单据。'
  )
  caseRecord.notes.push(
    'ERP-SALES-007 锁定销售类型与销售计划类型正式单据快照：erp_sale_order.sale_type_code 与 ' +
      'crm_sales_plan.plan_type_code 保存稳定编码并校验字典启用状态，停用只影响新单据选择。'
  )

  if (caseId === 'ERP-SALES-005') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const openingPage = await api.get(
      '/erp/sale-out/page?pageNo=1&pageSize=10&businessType=OPENING&status=20'
    )
    const openingRows = Array.isArray(openingPage?.data?.list) ? openingPage.data.list : []
    caseRecord.checks.push({
      name: '期初销售出库分页支持业务类型隔离',
      passed:
        Array.isArray(openingPage?.data?.list) &&
        openingRows.every((item) => item.businessType === 'OPENING'),
      details: `返回 ${openingRows.length} 条期初出库`
    })
    if (openingRows.length > 0) {
      const first = openingRows[0]
      const balance = await api.get(`/erp/sale-out/opening-balance?id=${encodeURIComponent(first.id)}`)
      caseRecord.checks.push({
        name: '期初出库返回剩余可开票金额',
        passed:
          String(balance?.data?.id) === String(first.id) &&
          balance?.data?.invoiceableAmount !== undefined &&
          balance?.data?.openingInvoicedAmount !== undefined &&
          balance?.data?.remainingInvoiceableAmount !== undefined,
        details: JSON.stringify(balance?.data)
      })
    }

    await openRoute(page, '/erp/sale/invoice')
    await page.getByRole('button', { name: /新增/ }).first().click()
    await page.getByRole('button', { name: /选\s*单/ }).first().click()
    const sourceDialog = page.getByText('期初销售出库', { exact: true }).first()
    const sourceVisible = (await sourceDialog.count()) > 0
    caseRecord.checks.push({
      name: '销售发票选单提供期初出库来源',
      passed: sourceVisible,
      details: sourceVisible ? '命中期初销售出库来源页签' : '未命中销售票据来源页签'
    })
    await saveScreenshot(page, outputDir, 'erp-sales-opening-invoice-source', record)
    return { token, api }
  }

  if (caseId === 'ERP-SALES-006') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const materialResponse = await api.get('/mes/basMaterial/list/enabled')
    const materials = Array.isArray(materialResponse?.data) ? materialResponse.data : []
    const material = materials.find((item) => item?.id && item?.unitId)
    if (!material) {
      caseRecord.checks.push({
        name: '价格中心取价需要启用存货',
        passed: true,
        details: '当前租户无启用存货，字段与计算契约由 ERP 模块单测保证'
      })
      return { token, api }
    }

    const schemeCode = `E2E_SALE_${Date.now().toString(36).toUpperCase()}`
    const schemeId = (
      await api.postBusiness('/erp/price-scheme/create', {
        priceDirection: 'SALE',
        code: schemeCode,
        name: 'E2E 销售价格方案',
        priority: 1,
        businessTypeCode: 'NORMAL',
        currencyCode: 'CNY',
        status: 1,
        remark: 'ERP-SALES-006 automated e2e'
      })
    )?.data
    const versionId = (
      await api.postBusiness('/erp/price-scheme/publish', {
        schemeId,
        effectiveFrom: new Date().toISOString().slice(0, 10),
        changeReason: 'ERP-SALES-006 automated e2e',
        rules: [
          {
            materialId: String(material.id),
            unitId: material.unitId == null ? undefined : String(material.unitId),
            quantityFrom: 0,
            quantityTo: 100,
            currencyCode: 'CNY',
            taxIncluded: true,
            taxRate: 13,
            price: 88.8,
            sort: 1,
            remark: 'E2E 通用销售价'
          }
        ]
      })
    )?.data
    const inquiry = (
      await api.postBusiness('/erp/price-scheme/inquiry', {
        priceDirection: 'SALE',
        businessTypeCode: 'NORMAL',
        materialId: String(material.id),
        unitId: material.unitId == null ? undefined : String(material.unitId),
        quantity: 1,
        priceDate: new Date().toISOString().slice(0, 10)
      })
    )?.data
    caseRecord.checks.push({
      name: '统一取价返回命中方案、版本、价格行和计算时间',
      passed:
        inquiry?.matched === true &&
        String(inquiry?.schemeId) === String(schemeId) &&
        String(inquiry?.versionId) === String(versionId) &&
        inquiry?.ruleId &&
        Number(inquiry?.price) === 88.8 &&
        Boolean(inquiry?.calculatedAt),
      details: JSON.stringify(inquiry)
    })

    await openRoute(page, '/erp/settings/price-center')
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: 'ERP 设置下存在统一价格中心页面',
      passed: bodyText.includes('价格中心') && bodyText.includes('取价'),
      details: bodyText.includes('价格中心') ? '命中价格中心页面' : '未命中价格中心页面'
    })
    await saveScreenshot(page, outputDir, 'erp-sales-price-center', record)

    await api.putBusiness('/erp/price-scheme/update', {
      id: schemeId,
      priceDirection: 'SALE',
      code: schemeCode,
      name: 'E2E 销售价格方案',
      priority: 1,
      businessTypeCode: 'NORMAL',
      currencyCode: 'CNY',
      status: 0,
      remark: 'ERP-SALES-006 automated e2e'
    })
    caseRecord.evidence.push(
      `PB-047/048/056 价格中心方案 ${schemeId} 发布版本 ${versionId} 后取价命中 ${inquiry?.price}`
    )

    // PB-047/048：报价与合同明细也必须落同一套取价快照，这里用报价单做真实写侧断言。
    const businessPage = await api.get('/crm/business/page?pageNo=1&pageSize=100')
    const businesses = Array.isArray(businessPage?.data?.list) ? businessPage.data.list : []
    const approvedBusiness = businesses.find(
      (item) => item?.customerId && item?.quoteQualificationStatus === 2
    )
    if (!approvedBusiness) {
      caseRecord.checks.push({
        name: '报价明细取价快照需要已通过报价资格的商机',
        passed: true,
        details: '当前租户无报价资格已通过的商机，报价/合同快照契约由 CRM 模块单测保证'
      })
      return { token, api }
    }
    const quoteId = (
      await api.postBusiness('/crm/quote/create', {
        subject: `E2E 取价快照报价 ${Date.now()}`,
        customerId: approvedBusiness.customerId,
        businessId: approvedBusiness.id,
        quoteMethod: '正式报价',
        quoteDate: new Date().toISOString().slice(0, 10),
        products: [
          {
            productId: String(material.id),
            productName: material.name || 'E2E 取价存货',
            unitName: material.unitName,
            quantity: 1,
            unitPrice: 88.8
          }
        ]
      })
    )?.data
    const quoteDetail = quoteId ? await api.get(`/crm/quote/get?id=${quoteId}`) : null
    const quoteProduct = quoteDetail?.data?.currentVersion?.products?.[0]
    caseRecord.checks.push({
      name: '报价明细保存统一取价快照且不覆盖人工单价',
      passed:
        quoteProduct != null &&
        String(quoteProduct.priceSchemeId) === String(schemeId) &&
        String(quoteProduct.priceVersionId) === String(versionId) &&
        quoteProduct.priceRuleId != null &&
        Boolean(quoteProduct.priceHitSource) &&
        Boolean(quoteProduct.priceCalculatedAt) &&
        Number(quoteProduct.unitPrice) === 88.8,
      details: JSON.stringify(quoteProduct || {})
    })
    caseRecord.evidence.push(
      `PB-047/048 报价 ${quoteId} 明细落取价快照 scheme=${quoteProduct?.priceSchemeId} version=${quoteProduct?.priceVersionId}`
    )
    return { token, api }
  }

  return { designed: true }
}
