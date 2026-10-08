import { randomBytes } from 'node:crypto'
import { assertBusinessSuccess } from '../lib/assertions.mjs'

const dataOf = (payload, label) => assertBusinessSuccess(payload, label).data
const stableId = (value) => /^[1-9]\d*$/.test(String(value ?? ''))
const localDateTime = () => new Date().toISOString().slice(0, 19)

const enabledConfig = (raw) => {
  if (typeof raw !== 'string' || !raw.trim()) return false
  if (['true', '1'].includes(raw.trim().toLowerCase())) return true
  try {
    const value = JSON.parse(raw)
    return value && [true, 'true', 1, '1'].includes(value.enabled)
  } catch {
    return false
  }
}

export const procurementSettlementFixturePayload = (tag, material, partnerId) => {
  const code = `E2E_PROC005_${tag}`
  const orderTime = localDateTime()
  return {
    code,
    dictionary: {
      sort: 900,
      label: `E2E结算-${tag}`,
      value: code,
      dictType: 'x_settle_method',
      status: 0,
      colorType: 'success',
      remark: `PROC-005 isolated fixture ${tag}`
    },
    rule: {
      settleMethodCode: code,
      parentGroupCode: 'E2E_PROC005',
      parentGroupName: 'PROC-005专属结算',
      direction: 'BOTH',
      allowedAccountTypes: null,
      requireBillNo: false,
      requireDueDate: false,
      allowCredit: true,
      defaultCreditDays: 30,
      effectiveFrom: orderTime.slice(0, 10),
      status: 1,
      remark: `PROC-005 isolated fixture ${tag}`
    },
    order: {
      type: 0,
      supplierId: String(partnerId),
      orderTime,
      billDate: orderTime.slice(0, 10),
      discountPercent: 0,
      discountPrice: 0,
      depositPrice: 0,
      totalCount: 1,
      totalProductPrice: 88.8,
      totalTaxPrice: 0,
      totalPrice: 88.8,
      settleMethodCode: code,
      directCreate: 1,
      directCreateReason: `PROC-005 isolated settlement snapshot ${tag}`,
      remark: `PROC-005 isolated fixture ${tag}`,
      items: [{
        entryNo: 1,
        productId: String(material.id),
        productUnitId: String(material.unitId),
        productPrice: 88.8,
        count: 1,
        taxPercent: 0,
        totalPrice: 88.8,
        taxPrice: 0,
        remark: `PROC-005 isolated line ${tag}`
      }]
    }
  }
}

const salePayload = (tag, material, customerId, settleMethodCode) => {
  const orderTime = localDateTime()
  return {
    customerId: String(customerId),
    orderTime,
    billDate: orderTime.slice(0, 10),
    discountPercent: 0,
    discountPrice: 0,
    depositPrice: 0,
    totalCount: 1,
    totalProductPrice: 88.8,
    totalTaxPrice: 0,
    totalPrice: 88.8,
    settleMethodCode,
    remark: `PROC-005 isolated sale snapshot ${tag}`,
    items: [{
      entryNo: 1,
      productId: String(material.id),
      productUnitId: String(material.unitId),
      productPrice: 88.8,
      count: 1,
      taxPercent: 0,
      totalPrice: 88.8,
      taxPrice: 0,
      remark: `PROC-005 isolated sale line ${tag}`
    }]
  }
}

export async function createProcurementSettlementFixture (api, caseRecord) {
  const tag = `${Date.now().toString(36).toUpperCase()}_${randomBytes(2).toString('hex')}`
  const option = dataOf(
    await api.getBusiness('/system/config/get?category=purchase&tag=requisition'),
    'PROC-005 请购开关'
  )
  if (option && enabledConfig(option.configData)) {
    throw new Error(
      'BLOCKED: PROC-005 请购开关已开启；不切换共享策略，当前直采夹具需要独立 direct-create 权限或有效请购来源'
    )
  }

  const materialPage = dataOf(
    await api.getBusiness(
      '/mes/basMaterial/list/dictText?pageNo=1&pageSize=100&purchased=Y&isEnabled=1'
    ),
    'PROC-005 可采购物料'
  )
  const material = materialPage?.records?.find((row) => stableId(row?.id) && stableId(row?.unitId))
  if (!material) throw new Error('BLOCKED: PROC-005 没有可采购的专属物料/单位')
  const saleMaterialPage = dataOf(
    await api.getBusiness(
      '/mes/basMaterial/list/dictText?pageNo=1&pageSize=100&saled=Y&isEnabled=1'
    ),
    'PROC-005 可销售物料'
  )
  const saleMaterial = saleMaterialPage?.records?.find((row) => stableId(row?.id) && stableId(row?.unitId))
  if (!saleMaterial) throw new Error('BLOCKED: PROC-005 没有可销售的专属物料/单位')

  const fixture = {
    kind: 'procurement-settlement',
    tag,
    status: 'creating',
    retained: true,
    reason: '专属实体逐步登记；保留已创建事实，后续失败不删除'
  }
  caseRecord.fixtures = [...(caseRecord.fixtures || []), fixture]
  const registerId = (field, id) => {
    fixture[field] = String(id)
    caseRecord.evidence.push(`PROC-005 retained ${field}=${id}，tag=${tag}`)
  }
  const partnerId = dataOf(await api.postBusiness('/base/partner/create', {
    name: `E2E-PROC005-SUPPLIER-${tag}`,
    shortName: 'E2E-PROC005',
    partnerKind: 'ORGANIZATION',
    status: 'ACTIVE',
    customerEnabled: false,
    supplierEnabled: true,
    carrierEnabled: false,
    remark: `PROC-005 isolated fixture ${tag}`
  }), 'PROC-005 专属供应商')
  if (!stableId(partnerId)) throw new Error('PROC-005 专属供应商未返回稳定 ID')
  registerId('supplierId', partnerId)

  const payload = procurementSettlementFixturePayload(tag, material, partnerId)
  fixture.settleMethodCode = payload.rule.settleMethodCode
  const dictionaryId = dataOf(
    await api.postBusiness('/system/dict-data/create', payload.dictionary),
    'PROC-005 专属结算方式'
  )
  if (!stableId(dictionaryId)) throw new Error('PROC-005 专属结算方式未返回稳定 ID')
  registerId('dictionaryId', dictionaryId)

  const ruleId = dataOf(
    await api.postBusiness('/erp/settle-method-rule/create', payload.rule),
    'PROC-005 专属结算规则'
  )
  if (!stableId(ruleId)) throw new Error('PROC-005 专属结算规则未返回稳定 ID')
  registerId('ruleId', ruleId)

  const orderId = dataOf(
    await api.postBusiness('/erp/purchase-order/create', payload.order),
    'PROC-005 专属采购订单'
  )
  if (!stableId(orderId)) throw new Error('PROC-005 专属采购订单未返回稳定 ID')
  registerId('orderId', orderId)

  const first = dataOf(
    await api.getBusiness(`/erp/purchase-order/get?id=${encodeURIComponent(orderId)}`),
    'PROC-005 采购订单首次快照'
  )
  if (String(first?.settleMethodCode) !== payload.rule.settleMethodCode ||
      Number(first?.settleMethodRuleVersion) !== 1) {
    throw new Error(
      `PROC-005 首次订单快照不匹配：code=${first?.settleMethodCode}, version=${first?.settleMethodRuleVersion}`
    )
  }
  fixture.ruleVersionAtCreate = 1

  const updatedRule = { ...payload.rule, id: ruleId, remark: `${payload.rule.remark} v2` }
  dataOf(await api.putBusiness('/erp/settle-method-rule/update', updatedRule),
    'PROC-005 专属结算规则更新')
  const second = dataOf(
    await api.getBusiness(`/erp/purchase-order/get?id=${encodeURIComponent(orderId)}`),
    'PROC-005 规则调整后订单快照'
  )
  const currentRule = dataOf(
    await api.getBusiness(`/erp/settle-method-rule/get?id=${encodeURIComponent(ruleId)}`),
    'PROC-005 当前规则版本'
  )
  const businessDate = payload.order.orderTime.slice(0, 10)
  if (currentRule?.settleMethodCode !== payload.rule.settleMethodCode ||
      Number(currentRule?.status) !== 1 ||
      !currentRule?.effectiveFrom ||
      businessDate < currentRule.effectiveFrom ||
      (currentRule.effectiveTo && businessDate > currentRule.effectiveTo)) {
    throw new Error('PROC-005 订单业务日期未处于专属启用规则生效范围')
  }
  if (Number(currentRule?.version) !== 2 ||
      Number(second?.settleMethodRuleVersion) !== 1) {
    throw new Error(
      `PROC-005 历史快照被回写或规则未递增：current=${currentRule?.version}, order=${second?.settleMethodRuleVersion}`
    )
  }

  const partner = dataOf(
    await api.getBusiness(`/base/partner/get?id=${encodeURIComponent(partnerId)}`),
    'PROC-005 专属客商回读'
  )
  if (String(partner?.id) !== String(partnerId) ||
      partner?.name !== `E2E-PROC005-SUPPLIER-${tag}` ||
      partner?.supplierEnabled !== true) {
    throw new Error('PROC-005 客商不属于本轮专属供应商，拒绝修改角色')
  }
  const customerPartner = {
    id: String(partnerId),
    name: partner.name,
    shortName: partner.shortName,
    partnerKind: partner.partnerKind,
    status: partner.status,
    customerEnabled: true,
    customerCode: partner.customerCode,
    supplierEnabled: true,
    supplierCode: partner.supplierCode,
    carrierEnabled: Boolean(partner.carrierEnabled),
    carrierCode: partner.carrierCode,
    remark: `PROC-005 customer role ${tag}`
  }
  dataOf(
    await api.putBusiness('/base/partner/update', customerPartner),
    'PROC-005 专属供应商开启客户角色'
  )
  fixture.customerId = String(partnerId)
  caseRecord.evidence.push(`PROC-005 专属客商 ${partnerId} 已通过正规 API 开启 CUSTOMER 角色`)
  const customer = dataOf(
    await api.getBusiness(`/base/partner/get?id=${encodeURIComponent(partnerId)}`),
    'PROC-005 专属客户角色回读'
  )
  if (String(customer?.id) !== String(partnerId) ||
      customer?.customerEnabled !== true || customer?.supplierEnabled !== true) {
    throw new Error('PROC-005 专属客商客户/供应商角色回读不匹配')
  }

  const saleOrderPayload = salePayload(tag, saleMaterial, partnerId, payload.rule.settleMethodCode)
  const saleOrderId = dataOf(
    await api.postBusiness('/erp/sale-order/create', saleOrderPayload),
    'PROC-005 专属销售订单'
  )
  if (!stableId(saleOrderId)) throw new Error('PROC-005 专属销售订单未返回稳定 ID')
  registerId('saleOrderId', saleOrderId)
  const saleSnapshot = dataOf(
    await api.getBusiness(`/erp/sale-order/get?id=${encodeURIComponent(saleOrderId)}`),
    'PROC-005 销售订单结算快照'
  )
  if (String(saleSnapshot?.settleMethodCode) !== payload.rule.settleMethodCode ||
      Number(saleSnapshot?.settleMethodRuleVersion) !== 2) {
    throw new Error(
      `PROC-005 销售订单快照不匹配：code=${saleSnapshot?.settleMethodCode}, version=${saleSnapshot?.settleMethodRuleVersion}`
    )
  }
  fixture.saleRuleVersionAtCreate = 2

  dataOf(await api.putBusiness('/erp/settle-method-rule/update', {
    ...updatedRule, status: 0, remark: `${payload.rule.remark} disabled v3`
  }), 'PROC-005 停用专属规则')
  const disabledRule = dataOf(
    await api.getBusiness(`/erp/settle-method-rule/get?id=${encodeURIComponent(ruleId)}`),
    'PROC-005 专属规则停用回读'
  )
  if (Number(disabledRule?.status) !== 0 || Number(disabledRule?.version) !== 3) {
    throw new Error('PROC-005 专属规则停用或版本3回读不匹配')
  }
  fixture.ruleDisabled = true
  fixture.ruleVersionAfterDisable = 3
  const readHistory = async (label) => {
    const purchase = dataOf(
      await api.getBusiness(`/erp/purchase-order/get?id=${encodeURIComponent(orderId)}`), label
    )
    const sale = dataOf(
      await api.getBusiness(`/erp/sale-order/get?id=${encodeURIComponent(saleOrderId)}`), label
    )
    if (purchase?.settleMethodCode !== fixture.settleMethodCode ||
        sale?.settleMethodCode !== fixture.settleMethodCode ||
        Number(purchase?.settleMethodRuleVersion) !== 1 ||
        Number(sale?.settleMethodRuleVersion) !== 2) {
      throw new Error(`PROC-005 ${label}历史订单结算编码/版本被回写`)
    }
    return { purchase, sale }
  }
  const afterRuleDisable = await readHistory('规则停用后')
  const ownedDictionary = dataOf(
    await api.getBusiness(`/system/dict-data/get?id=${encodeURIComponent(dictionaryId)}`),
    'PROC-005 停用前专属字典归属回读'
  )
  if (String(ownedDictionary?.id) !== String(dictionaryId) ||
      ownedDictionary?.value !== fixture.settleMethodCode ||
      ownedDictionary?.dictType !== 'x_settle_method') {
    throw new Error('PROC-005 字典不属于本轮专属结算方式，拒绝停用')
  }
  dataOf(
    await api.putBusiness('/system/dict-data/update', {
      ...payload.dictionary,
      id: String(dictionaryId),
      status: 1
    }),
    'PROC-005 停用专属结算方式'
  )
  fixture.disabledDictionary = true
  const disabledDictionary = dataOf(
    await api.getBusiness(`/system/dict-data/get?id=${encodeURIComponent(dictionaryId)}`),
    'PROC-005 专属结算方式停用回读'
  )
  if (Number(disabledDictionary?.status) !== 1) {
    throw new Error(`PROC-005 专属结算方式未停用：status=${disabledDictionary?.status}`)
  }
  const rejectDisabled = async (path, body, unexpectedIdField) => {
    const response = await api.post(path, {
      ...body, remark: `PROC-005 rejected disabled settlement ${tag}`
    })
    if ([0, 200].includes(response?.code) && stableId(response?.data)) {
      registerId(unexpectedIdField, response.data)
    }
    caseRecord.evidence.push(
      `PROC-005 停用专属字典 POST ${path} -> code=${response?.code}, msg=${response?.msg || ''}`
    )
    if (Number(response?.code) !== 1030102016 ||
        !String(response?.msg || '').includes(fixture.settleMethodCode)) {
      throw new Error(`PROC-005 停用字典拒绝新单错误不匹配：${JSON.stringify(response)}`)
    }
    return response
  }
  const rejectedPurchase = await rejectDisabled(
    '/erp/purchase-order/create', payload.order, 'unexpectedPurchaseOrderId'
  )
  const rejectedSale = await rejectDisabled(
    '/erp/sale-order/create', saleOrderPayload, 'unexpectedSaleOrderId'
  )
  fixture.disabledCreateRejected = true
  const afterDictionaryDisable = await readHistory('字典停用后')

  Object.assign(fixture, {
    status: 'verified',
    ruleVersionAfterUpdate: 2,
    reason: '采购订单引用供应商、字典结算方式和规则版本，保留业务事实不删除'
  })
  caseRecord.evidence.push(
    `PROC-005 专属供应商=${partnerId}、结算方式=${payload.rule.settleMethodCode}、规则=${ruleId}、订单=${orderId}；订单版本1，规则更新为2后订单仍为1`
  )
  caseRecord.evidence.push(
    `PROC-005 业务日期=${businessDate}，规则生效日=${currentRule.effectiveFrom}；销售订单=${saleOrderId}版本2；规则停用版本3、字典停用后历史采购1/销售2均不变`
  )
  return {
    fixture,
    payload,
    first,
    second,
    currentRule,
    saleSnapshot,
    disabledDictionary,
    rejectedSale,
    rejectedPurchase,
    afterRuleDisable,
    afterDictionaryDisable
  }
}
