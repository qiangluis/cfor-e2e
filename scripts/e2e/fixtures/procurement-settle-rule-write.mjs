import { randomBytes } from 'node:crypto'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { assertProcurementDirectCreateGate } from './procurement-direct-create-gate.mjs'

const dataOf = (payload, label) => assertBusinessSuccess(payload, label).data
const stableId = (value) => /^[1-9]\d*$/.test(String(value ?? ''))
const localDateTime = () => new Date().toISOString().slice(0, 19)

/**
 * PB settings real write side for the 结算方式规则 page (PROC-006).
 *
 * Creates an isolated x_settle_method dictionary entry + rule with a unique
 * E2E_PROC006 code, then proves: rule create -> version 1, rule update ->
 * version 2, purchase orders snapshot the version in force at business time,
 * later rule edits never retroactively rewrite historical order snapshots, and
 * the rule can be disabled (not deleted) at the end.
 */
export async function createSettleRuleWriteFixture (api, caseRecord) {
  const tag = `${Date.now().toString(36).toUpperCase()}_${randomBytes(2).toString('hex')}`
  const directCreateGate = await assertProcurementDirectCreateGate(api, 'PROC-006')

  const materialPage = dataOf(
    await api.getBusiness(
      '/mes/basMaterial/list/dictText?pageNo=1&pageSize=100&purchased=Y&isEnabled=1'
    ),
    'PROC-006 可采购物料'
  )
  const material = materialPage?.records?.find((row) => stableId(row?.id) && stableId(row?.unitId))
  if (!material) throw new Error('BLOCKED: PROC-006 没有可采购的物料/单位')

  const fixture = {
    kind: 'procurement-settle-rule-write',
    tag,
    status: 'creating',
    retained: true,
    requisitionEnabled: directCreateGate.requisitionEnabled,
    directCreatePermission: directCreateGate.directCreatePermission,
    reason: '专属结算方式与规则逐步登记；结束后停用规则不删除平台模板'
  }
  caseRecord.fixtures = [...(caseRecord.fixtures || []), fixture]
  const registerId = (field, id) => {
    fixture[field] = String(id)
    caseRecord.evidence.push(`PROC-006 retained ${field}=${id}，tag=${tag}`)
  }

  const partnerId = dataOf(await api.postBusiness('/base/partner/create', {
    name: `E2E-PROC006-SUPPLIER-${tag}`,
    shortName: 'E2E-PROC006',
    partnerKind: 'ORGANIZATION',
    status: 'ACTIVE',
    customerEnabled: false,
    supplierEnabled: true,
    carrierEnabled: false,
    remark: `PROC-006 isolated settle rule fixture ${tag}`
  }), 'PROC-006 专属供应商')
  if (!stableId(partnerId)) throw new Error('PROC-006 专属供应商未返回稳定 ID')
  registerId('supplierId', partnerId)

  const code = `E2E_PROC006_${tag}`
  fixture.settleMethodCode = code
  const dictionaryId = dataOf(await api.postBusiness('/system/dict-data/create', {
    sort: 901,
    label: `E2E结算规则-${tag}`,
    value: code,
    dictType: 'x_settle_method',
    status: 0,
    colorType: 'success',
    remark: `PROC-006 isolated fixture ${tag}`
  }), 'PROC-006 专属结算方式字典')
  if (!stableId(dictionaryId)) throw new Error('PROC-006 专属结算方式字典未返回稳定 ID')
  registerId('dictionaryId', dictionaryId)

  const ruleBase = {
    settleMethodCode: code,
    parentGroupCode: 'E2E_PROC006',
    parentGroupName: 'PROC-006专属结算',
    direction: 'BOTH',
    allowedAccountTypes: null,
    requireBillNo: false,
    requireDueDate: false,
    allowCredit: true,
    defaultCreditDays: 30,
    effectiveFrom: localDateTime().slice(0, 10),
    status: 1,
    remark: `PROC-006 isolated rule ${tag}`
  }
  const ruleId = dataOf(
    await api.postBusiness('/erp/settle-method-rule/create', ruleBase),
    'PROC-006 专属结算规则创建'
  )
  if (!stableId(ruleId)) throw new Error('PROC-006 专属结算规则未返回稳定 ID')
  registerId('ruleId', ruleId)

  const createdRule = dataOf(
    await api.getBusiness(`/erp/settle-method-rule/get?id=${encodeURIComponent(ruleId)}`),
    'PROC-006 规则创建详情'
  )
  if (Number(createdRule?.version) !== 1) {
    throw new Error(`PROC-006 新规则版本非 1：version=${createdRule?.version}`)
  }

  const createOrder = async (suffix) => {
    const orderTime = localDateTime()
    const orderId = dataOf(await api.postBusiness('/erp/purchase-order/create', {
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
      directCreateReason: `PROC-006 isolated order ${suffix} ${tag}`,
      remark: `PROC-006 isolated order ${suffix} ${tag}`,
      items: [{
        entryNo: 1,
        productId: String(material.id),
        productUnitId: String(material.unitId),
        productPrice: 88.8,
        count: 1,
        taxPercent: 0,
        totalPrice: 88.8,
        taxPrice: 0,
        remark: `PROC-006 isolated line ${suffix} ${tag}`
      }]
    }), `PROC-006 专属采购订单 ${suffix}`)
    if (!stableId(orderId)) throw new Error(`PROC-006 专属采购订单 ${suffix} 未返回稳定 ID`)
    const detail = dataOf(
      await api.getBusiness(`/erp/purchase-order/get?id=${encodeURIComponent(orderId)}`),
      `PROC-006 采购订单 ${suffix} 快照`
    )
    return { orderId: String(orderId), detail }
  }

  const orderV1 = await createOrder('v1')
  registerId('orderV1Id', orderV1.orderId)
  if (orderV1.detail?.settleMethodCode !== code || Number(orderV1.detail?.settleMethodRuleVersion) !== 1) {
    throw new Error(
      `PROC-006 首单未命中规则版本1：code=${orderV1.detail?.settleMethodCode}, version=${orderV1.detail?.settleMethodRuleVersion}`
    )
  }

  const updatedRule = { ...ruleBase, id: ruleId, remark: `${ruleBase.remark} v2` }
  dataOf(
    await api.putBusiness('/erp/settle-method-rule/update', updatedRule),
    'PROC-006 规则更新至版本2'
  )
  const ruleV2 = dataOf(
    await api.getBusiness(`/erp/settle-method-rule/get?id=${encodeURIComponent(ruleId)}`),
    'PROC-006 规则版本2详情'
  )
  const versions = dataOf(
    await api.getBusiness(
      `/erp/settle-method-rule/list-by-code?settleMethodCode=${encodeURIComponent(code)}`
    ),
    'PROC-006 规则版本列表'
  )

  const orderV2 = await createOrder('v2')
  registerId('orderV2Id', orderV2.orderId)

  // The rule is later disabled; the already-snapshotted orders must not move.
  dataOf(
    await api.putBusiness('/erp/settle-method-rule/update', {
      ...ruleBase,
      id: ruleId,
      status: 0,
      remark: `${ruleBase.remark} disabled`
    }),
    'PROC-006 规则停用'
  )
  const finalRule = dataOf(
    await api.getBusiness(`/erp/settle-method-rule/get?id=${encodeURIComponent(ruleId)}`),
    'PROC-006 规则停用详情'
  )
  const orderV1After = dataOf(
    await api.getBusiness(`/erp/purchase-order/get?id=${encodeURIComponent(orderV1.orderId)}`),
    'PROC-006 停用后历史订单回读'
  )

  return {
    tag,
    fixture,
    code,
    ruleId: String(ruleId),
    dictionaryId: String(dictionaryId),
    ruleBase,
    createdRule,
    ruleV2,
    versions,
    orderV1,
    orderV2,
    finalRule,
    orderV1After
  }
}
