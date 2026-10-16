import assert from 'node:assert/strict'
import test from 'node:test'

import { matchesExpectedBusinessRejection } from '../lib/api.mjs'
import {
  __internal,
  cleanupMaterialValidationFixtures,
  materialValidationCheckNames,
  materialValidationRejections
} from '../fixtures/material-validation-closure.mjs'

test('PB032 uses exact master-data and WMS rejection contracts', () => {
  assert.equal(matchesExpectedBusinessRejection(
    { code: 2010100006, msg: '存货(A)配置不合法：实物存货必须维护主单位' },
    materialValidationRejections.stockWithoutUnit
  ), true)
  assert.equal(matchesExpectedBusinessRejection(
    { code: 2010100006, msg: '存货(A)配置不合法：启用保质期管理时，保质期天数必须为正整数' },
    materialValidationRejections.invalidPeriodDays
  ), true)
  assert.equal(matchesExpectedBusinessRejection(
    { code: 500, msg: '存货(A)不能用于仓储库存：服务项目和虚拟件禁止进入实物库存' },
    materialValidationRejections.nonPhysicalWmsStock
  ), true)
})

test('PB032 closure check names remain stable catalog evidence identifiers', () => {
  assert.deepEqual(materialValidationCheckNames, {
    serviceReadback: 'SERVICE 非实物档案回读并自动清空仓储控制',
    virtualReadback: 'VIRTUAL 非实物档案回读并自动清空仓储控制',
    serviceWmsRejected: 'SERVICE 非实物存货进入 WMS 正式保存被精确拒绝且不生成单据',
    virtualWmsRejected: 'VIRTUAL 非实物存货进入 WMS 正式保存被精确拒绝且不生成单据'
  })
})

test('non-physical material body is normalized and ownership requires full marker snapshot', () => {
  const body = __internal.materialBody({
    code: 'E2E-PB032-UNIT-SERVICE', marker: 'E2E-PB032-UNIT', inventoryNature: 'SERVICE', unitId: '1'
  })
  assert.equal(body.inventoryNature, 'SERVICE')
  const expected = { id: '9', code: body.code, marker: body.remark, inventoryNature: 'SERVICE' }
  const row = {
    id: '9', code: body.code, name: body.code, remark: body.remark, inventoryNature: 'SERVICE',
    batchManaged: 'N', periodManaged: 'N', periodDays: null, defaultWare: null,
    defaultWareArea: null, defaultWareLocation: null
  }
  assert.equal(__internal.ownsMaterial(row, expected), true)
  assert.equal(__internal.ownsMaterial({ ...row, remark: 'foreign' }, expected), false)
  assert.equal(__internal.ownsMaterial({ ...row, periodManaged: 'Y' }, expected), false)
})

test('WMS draft requires complete dedicated location IDs and preserves string snowflake IDs', () => {
  assert.deepEqual(__internal.stockLocationIds({
    warehouse: { id: '9007199254740993' }, area: { id: '2' }, location: { id: '3' }
  }), { warehouseId: '9007199254740993', wareAreaId: '2', wareLocationId: '3' })
  assert.throws(() => __internal.stockLocationIds({ warehouseId: 9007199254740993, wareAreaId: '2', wareLocationId: '3' }), /不安全数字 ID/)
})

test('cleanup deletes only owned non-physical records and proves absence', async () => {
  let deleted = false
  const material = {
    id: '9', code: 'E2E-PB032-UNIT-SERVICE', marker: 'E2E-PB032-UNIT', inventoryNature: 'SERVICE'
  }
  const detail = {
    id: '9', code: material.code, name: material.code, remark: material.marker, inventoryNature: 'SERVICE',
    batchManaged: 'N', periodManaged: 'N', periodDays: null, defaultWare: null,
    defaultWareArea: null, defaultWareLocation: null
  }
  const api = {
    async getBusiness (pathname) {
      if (pathname.includes('/list?')) return { code: 0, data: { records: [] } }
      return { code: 0, data: detail }
    },
    async deleteBusiness () { deleted = true; return { code: 0, data: true } },
  }
  const record = { checks: [] }
  await cleanupMaterialValidationFixtures(api, { materials: [material] }, record)
  assert.equal(deleted, true)
  assert.equal(record.checks.every((check) => check.passed), true)
  assert.equal(record.checks[0].name, 'PB032 专属非实物存货删除后分页按 ID/编码不可见')
})

test('cleanup treats a residual matching ID or code in the filtered page as a hard failure', async () => {
  let deleted = false
  const material = {
    id: '9', code: 'E2E-PB032-UNIT-SERVICE', marker: 'E2E-PB032-UNIT', inventoryNature: 'SERVICE'
  }
  const detail = {
    id: '9', code: material.code, name: material.code, remark: material.marker, inventoryNature: 'SERVICE',
    batchManaged: 'N', periodManaged: 'N', periodDays: null, defaultWare: null,
    defaultWareArea: null, defaultWareLocation: null
  }
  const api = {
    async getBusiness (pathname) {
      if (pathname.includes('/list?')) return { code: 0, data: { records: [detail] } }
      return { code: 0, data: detail }
    },
    async deleteBusiness () { deleted = true; return { code: 0, data: true } }
  }
  await assert.rejects(() => cleanupMaterialValidationFixtures(api, { materials: [material] }, { checks: [] }),
    /删除后分页按 ID\/编码不可见/)
  assert.equal(deleted, true)
})

test('cleanup refuses unowned or incompletely normalized material without deleting it', async () => {
  let deleted = false
  const api = {
    async getBusiness () {
      return { code: 0, data: {
        id: '9', code: 'E2E-PB032-UNIT-SERVICE', name: 'E2E-PB032-UNIT-SERVICE', remark: 'foreign',
        inventoryNature: 'SERVICE', batchManaged: 'N', periodManaged: 'N'
      } }
    },
    async deleteBusiness () { deleted = true; return { code: 0 } }
  }
  await assert.rejects(() => cleanupMaterialValidationFixtures(api, {
    materials: [{ id: '9', code: 'E2E-PB032-UNIT-SERVICE', marker: 'owned', inventoryNature: 'SERVICE' }]
  }, { checks: [] }), /所有权、档案形态或仓储控制不匹配/)
  assert.equal(deleted, false)
})
