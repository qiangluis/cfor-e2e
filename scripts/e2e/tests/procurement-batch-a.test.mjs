import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createFinanceRuleWriteFixture,
  createOpeningInvoiceWriteFixture,
  createPurchaseTypeRuleWriteFixture,
  procurementBatchContracts,
  matchesExactProcurementRejection
} from '../fixtures/procurement-batch-a.mjs'

const ok = (data) => ({ code: 0, data })
const record = () => ({ evidence: [], notes: [], checks: [] })
const ids = {
  type: '2108966994821517313',
  negativeType: '2108966994884431873',
  rule: '2108966994884431877',
  partner: '2108967034210226178',
  material: '2108967034210226181',
  unit: '2108967034210226183',
  warehouse: '2108967034210226185',
  account: '2108967034210226187',
  order: '2108967034210226189',
  opening: '2108967034210226191',
  invoice: '2108967034210226193'
}

test('procurement negative contracts reject transport, wrong-domain, and leaked-data responses', () => {
  assert.equal(matchesExactProcurementRejection({
    code: 403, data: null, msg: '无权限'
  }, procurementBatchContracts.documentTypeReferenced), false)
  assert.equal(matchesExactProcurementRejection({
    code: 1030102014, data: null, msg: '采购订单单据类型不存在或未启用'
  }, procurementBatchContracts.financeRuleDuplicate), false)
  assert.equal(matchesExactProcurementRejection({
    code: procurementBatchContracts.documentTypeReferenced.code,
    data: { sourceId: ids.type },
    msg: '单据类型已被业务引用，不能删除，只能停用'
  }, procurementBatchContracts.documentTypeReferenced), false)
})

test('finance rule fixture requires exact rejection contracts and retains complete snapshots', async () => {
  let typesCreated = 0
  let typeCode
  let rule
  const documentTypes = new Map()
  const api = {
    async getBusiness (path) {
      if (path.startsWith('/system/document/type/get')) {
        const id = new URL(`http://fixture${path}`).searchParams.get('id')
        return ok(documentTypes.get(id) || { id, code: typeCode, isOpen: true })
      }
      if (path.startsWith('/erp/finance-document-type-rule/get')) return ok({ ...rule })
      if (path.startsWith('/finance/finReceipt/queryById')) {
        throw new Error('skip runtime default approval probe in contract test')
      }
      throw new Error(`Unexpected GET ${path}`)
    },
    async postBusiness (path, body) {
      if (path === '/system/document/type/create') {
        typesCreated++
        const id = typesCreated === 1 ? ids.type : ids.negativeType
        typeCode = body.code
        documentTypes.set(id, { ...body, id })
        return ok(id)
      }
      if (path === '/erp/finance-document-type-rule/create') {
        rule = { ...body, id: ids.rule, documentTypeCode: typeCode }
        return ok(ids.rule)
      }
      if (path === '/finance/finReceipt/add/submit') {
        throw new Error('skip runtime default approval probe in contract test')
      }
      throw new Error(`Unexpected POST business ${path}`)
    },
    async post (path, body) {
      if (path === '/erp/finance-document-type-rule/create') {
        return {
          code: procurementBatchContracts.financeRuleDuplicate.code,
          data: null,
          msg: '单据类型已存在启用中的财务规则'
        }
      }
      if (path === '/finance/finReceipt/add/save') {
        return {
          code: 500,
          data: null,
          msg: body.bankAccountId == null ? '缺少必填字段bankAccountId' : '不允许手工创建单据'
        }
      }
      throw new Error(`Unexpected POST ${path}`)
    },
    async putBusiness (path, body) {
      assert.equal(path, '/erp/finance-document-type-rule/update')
      rule = { ...rule, ...body }
      return ok(true)
    },
    async deleteBusiness (path) {
      assert.equal(path, `/erp/finance-document-type-rule/delete?id=${ids.rule}`)
      return ok(true)
    },
    async delete (path, options) {
      assert.equal(path, `/system/document/type/delete?id=${ids.type}`)
      assert.deepEqual(options.expectedBusinessRejection, procurementBatchContracts.documentTypeReferenced)
      return {
        code: procurementBatchContracts.documentTypeReferenced.code,
        data: null,
        msg: `单据类型(${ids.type})已被业务引用，不能删除，只能停用`
      }
    }
  }
  const result = await createFinanceRuleWriteFixture(api, record())
  assert.equal(result.fixture.status, 'verified')
  assert.deepEqual(result.manualCreateBefore, result.manualCreateAfter)
  assert.deepEqual(result.requiredFieldBefore, result.requiredFieldAfter)
  assert.deepEqual(result.duplicateBefore, result.duplicateAfter)
  assert.deepEqual(result.deleteTypeBefore, result.deleteTypeAfter)
  assert.equal(result.deleteTypeRejected.data, null)
})

test('purchase type fixtures preserve long identifiers through rules and order snapshots', async () => {
  let typesCreated = 0
  let typeCode
  let rule
  let order
  const documentTypes = new Map()
  const api = {
    async getBusiness (path) {
      if (path.startsWith('/system/config/get')) return ok({ configData: 'false' })
      if (path.startsWith('/system/document/type/get')) {
        const id = new URL(`http://fixture${path}`).searchParams.get('id')
        return ok(documentTypes.get(id) || { id, code: id === ids.type ? typeCode : 'FIN_E2E_NEG', isOpen: true })
      }
      if (path.startsWith('/mes/basMaterial/list/')) {
        return ok({ records: [{ id: ids.material, unitId: ids.unit }] })
      }
      if (path.startsWith('/erp/purchase-type-rule/get')) return ok({ ...rule })
      if (path.startsWith('/erp/purchase-order/get')) return ok(order)
      throw new Error(`Unexpected GET ${path}`)
    },
    async postBusiness (path, body) {
      if (path === '/system/document/type/create') {
        typesCreated++
        if (typesCreated === 1) typeCode = body.code
        const id = typesCreated === 1 ? ids.type : ids.negativeType
        documentTypes.set(id, { ...body, id })
        return ok(id)
      }
      if (path === '/erp/purchase-type-rule/create') {
        assert.equal(body.documentTypeId, ids.type)
        rule = { ...body, id: ids.rule, documentTypeCode: typeCode, version: 1 }
        return ok(ids.rule)
      }
      if (path === '/base/partner/create') return ok(ids.partner)
      if (path === '/erp/purchase-order/create') {
        assert.equal(body.documentTypeId, ids.type)
        assert.equal(body.supplierId, ids.partner)
        assert.equal(body.items[0].productId, ids.material)
        order = {
          ...body,
          id: ids.order,
          documentTypeCode: typeCode,
          documentTypeRuleVersion: 1
        }
        return ok(ids.order)
      }
      throw new Error(`Unexpected POST ${path}`)
    },
    async post (path, body) {
      assert.equal(path, '/erp/purchase-type-rule/create')
      assert.equal(body.documentTypeId, ids.negativeType)
      return {
        code: 1030102014,
        data: null,
        msg: '采购订单单据类型不存在或未启用'
      }
    },
    async putBusiness (path, body) {
      assert.equal(path, '/erp/purchase-type-rule/update')
      assert.equal(body.id, ids.rule)
      assert.equal(body.documentTypeId, ids.type)
      rule = { ...rule, ...body, version: rule.version + 1 }
      return ok(true)
    },
    async delete (path, options) {
      assert.equal(options.expectedBusinessRejection.code, 1002029003)
      assert.match('已被业务引用，不能删除，只能停用', options.expectedBusinessRejection.message)
      assert.match(path, new RegExp(`id=${ids.type}$`))
      return {
        code: 1002029003,
        data: null,
        msg: `单据类型(${ids.type})已被业务引用，不能删除，只能停用`
      }
    }
  }
  const result = await createPurchaseTypeRuleWriteFixture(api, record())
  assert.equal(result.fixture.status, 'verified')
  assert.equal(result.disabled.version, 3)
  assert.equal(result.order.detail.documentTypeRuleVersion, 1)
  assert.deepEqual(result.nonPurchaseBefore, result.nonPurchaseAfter)
  assert.deepEqual(result.deleteTypeBefore, result.deleteTypeAfter)
  assert.equal(result.deleteTypeBefore.order.id, ids.order)
})

test('opening invoice fixtures create a dedicated account and keep partner IDs lossless', async () => {
  let opening
  let invoiced = false
  let invoice
  const caseRecord = record()
  const api = {
    async getBusiness (path) {
      if (path.startsWith('/mes/basMaterial/list/')) {
        return ok({ records: [{ id: ids.material, unitId: ids.unit }] })
      }
      if (path === '/mes/wmsWareHouse/allTree') return ok([{ id: ids.warehouse }])
      if (path.startsWith('/mes/stkInventory/list')) return ok({ records: [] })
      if (path.startsWith('/erp/purchase-in/get')) {
        return ok({
          ...opening,
          status: 20,
          totalCount: 6,
          totalPrice: 60,
          invoicedCount: invoiced ? 6 : 0,
          invoicedPrice: invoiced ? 60 : 0
        })
      }
      if (path.startsWith('/erp/purchase-invoice/get')) return ok(invoice)
      throw new Error(`Unexpected GET ${path}`)
    },
    async postBusiness (path, body) {
      if (path === '/base/partner/create') return ok(ids.partner)
      if (path === '/erp/account/create') {
        assert.equal(body.accountType, 'BANK')
        assert.equal(body.status, 0)
        assert.match(body.no, /^E2E-PROC011-/)
        return ok(ids.account)
      }
      if (path === '/erp/purchase-in/create') {
        assert.equal(body.accountId, ids.account)
        assert.equal(caseRecord.fixtures[0].accountId, ids.account)
        opening = body
        return ok(ids.opening)
      }
      if (path === '/erp/purchase-invoice/create') {
        assert.equal(body.supplierId, ids.partner)
        assert.equal(body.items[0].purchaseInId, ids.opening)
        invoice = {
          ...body,
          id: ids.invoice,
          srcBillType: 'OPENING_PURCHASE_IN',
          srcBillId: ids.opening,
          details: JSON.stringify(body.items)
        }
        return ok(ids.invoice)
      }
      throw new Error(`Unexpected POST ${path}`)
    },
    async post (path, body) {
      assert.equal(path, '/erp/purchase-invoice/create')
      assert.equal(body.supplierId, ids.partner)
      if (body.invoiceMoney === 70 || body.invoiceMoney === 61) {
        return {
          code: 1020205004,
          data: null,
          msg: `开票金额(${body.invoiceMoney})超过期初采购入库剩余可开票金额(60.000000)`
        }
      }
      return {
        code: -645,
        data: null,
        msg: '采购订单：(E2E-OPENING),存在未审核完成的发票,审核完再提交'
      }
    },
    async putBusiness (path) {
      if (path.startsWith('/erp/purchase-invoice/update-status')) invoiced = true
      return ok(true)
    }
  }
  const result = await createOpeningInvoiceWriteFixture(api, caseRecord)
  assert.equal(result.fixture.status, 'verified')
  assert.equal(result.fixture.accountId, ids.account)
  assert.equal(result.beforeInventory, result.afterInventory)
  assert.deepEqual(result.overflowCountBefore, result.overflowCountAfter)
  assert.deepEqual(result.overflowMoneyBefore, result.overflowMoneyAfter)
  assert.deepEqual(result.pendingDuplicateBefore, result.pendingDuplicateAfter)
})
