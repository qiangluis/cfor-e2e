import assert from 'node:assert/strict'
import {
  dataOf, prepareWmsFixture, createOpeningInventory, inventorySnapshot
} from '../lib/wms-fixtures.mjs'
import { matchesExpectedBusinessRejection } from '../lib/api.mjs'

export const dimensionContracts = Object.freeze({
  area: { code: 1001001004, message: /的库区维度已被库存、未完成任务或未完成单据引用，不能关闭库区开关/ },
  location: { code: 1001001005, message: /的库位维度已被库存、未完成任务或未完成单据引用，不能关闭库位开关/ }
})

const canonical = (value) => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
    : item)

export async function verifyWarehouseDimensionInventory (api, caseRecord) {
  const fixture = await prepareWmsFixture(api, caseRecord, 81)
  const opening = await createOpeningInventory(
    api, caseRecord, fixture, fixture.material, fixture.unit.id, 1
  )
  assert.equal(opening.approved, true, '仓库维度保护前置必须为生效实物库存')
  const path = `/mes/wmsWareHouse/queryById?id=${encodeURIComponent(fixture.warehouse.id)}`
  const before = dataOf(await api.getBusiness(path))
  const inventoryBefore = await inventorySnapshot(api, fixture, fixture.material.id)
  assert.ok(inventoryBefore.some((row) => Number(row.qty) === 1 &&
    String(row.wareLocationId) === String(fixture.location.id)), '必须验证正式库位库存非空')
  for (const [label, body, contract] of [
    ['库位', { areaEnabled: true, locationEnabled: false }, dimensionContracts.location],
    ['库区及库位', { areaEnabled: false, locationEnabled: false }, dimensionContracts.area]
  ]) {
    const response = await api.put('/mes/wmsWareHouse/edit', {
      id: String(fixture.warehouse.id),
      pid: '0',
      code: before.code,
      name: before.name,
      ...body
    }, { expectedBusinessRejection: contract })
    const after = dataOf(await api.getBusiness(path))
    const inventoryAfter = await inventorySnapshot(api, fixture, fixture.material.id)
    caseRecord.checks.push({
      name: `正式库存仓库关闭${label}领域拒绝且配置库存原值不变`,
      passed: matchesExpectedBusinessRejection(response, contract) &&
        canonical(before) === canonical(after) &&
        canonical(inventoryBefore) === canonical(inventoryAfter),
      details: JSON.stringify({
        warehouse: fixture.warehouse.id, opening: opening.id,
        code: response.code, message: response.msg || response.message
      })
    })
  }
  return fixture
}
