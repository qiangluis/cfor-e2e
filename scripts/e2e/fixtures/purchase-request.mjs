import { randomBytes } from 'node:crypto'
import { runReadOnlySql } from '../lib/db.mjs'

export async function createPurchaseRequest (api, caseRecord) {
  const materials = await api.getBusiness(
    '/mes/basMaterial/list/dictText?pageNo=1&pageSize=100&purchased=Y&isEnabled=1'
  )
  const material = materials.data?.records?.find((row) => row.id && row.unitId)
  if (!material) throw new Error('BLOCKED: 请先通过初始化或存货页面准备启用的可采购存货和单位')
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(2, 12)
  const billNo = `AUTOTEST-PROC-${stamp}-${randomBytes(2).toString('hex')}`
  const now = new Date().toISOString().slice(0, 19)
  const payload = {
    billNo,
    billType: '18',
    status: 0,
    orderTime: now,
    expectedOrderTime: now,
    remark: 'PROC-014 isolated acceptance fixture',
    itemsList: [3, 5].map((quantity, index) => ({
      productId: String(material.id),
      productUnitId: String(material.unitId),
      inCount: quantity,
      purchasedQuantity: 0,
      remark: `${billNo}-line-${index + 1}`
    }))
  }
  const created = await api.postBusiness('/erp/purchase/order/request/create', payload)
  const id = String(created.data)
  if (!/^\d+$/.test(id)) throw new Error('请购创建未返回稳定的数字 ID')
  const read = async () => (
    await api.getBusiness(`/erp/purchase/order/request/get?id=${id}`)
  ).data
  caseRecord.fixtures = [...(caseRecord.fixtures || []), {
    kind: 'purchase-request', id, billNo, request: payload
  }]
  return { id, billNo, read, initial: await read() }
}

export async function snapshotPurchaseRequest (fixture, caseRecord, stage) {
  const snapshot = await runReadOnlySql(`
    SELECT 'bill', id, is_closed, COALESCE(is_place_order, 0), total_count, tenant_id,
           bill_stage, is_effective, status
    FROM erp_purchase_order_request WHERE id = ${fixture.id} AND deleted = 0;
    SELECT 'item', id, is_closed, in_count, COALESCE(purchased_quantity, 0), tenant_id, entry_no
    FROM erp_purchase_order_request_items WHERE mid = '${fixture.id}' AND deleted = 0
    ORDER BY id;
    SELECT 'audit', bill_id, log_type, log_content
    FROM mes_update_history
    WHERE deleted = 0 AND (
      bill_id = '${fixture.id}' OR bill_id IN (
        SELECT CAST(id AS CHAR) FROM erp_purchase_order_request_items
        WHERE mid = '${fixture.id}' AND deleted = 0
      )
    )
    ORDER BY id
  `)
  if (!snapshot.available) throw new Error(`BLOCKED: ${snapshot.reason}`)
  caseRecord.database = [...(caseRecord.database || []), { stage, ...snapshot }]
  return snapshot.rows
}
