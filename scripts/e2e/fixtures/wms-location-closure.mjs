import assert from 'node:assert/strict'
import {
  WMS_FIXTURE_MARK, dataOf, fixtureCode, prepareWmsFixture,
  createOpeningInventory, inventorySnapshot
} from '../lib/wms-fixtures.mjs'
import { matchesExpectedBusinessRejection } from '../lib/api.mjs'

const locationPath = (id) => `/mes/wms-house-location/get?id=${encodeURIComponent(id)}`
const inUse = { code: 1001001003, message: /已被库存、未完成任务或未完成单据引用/ }

export const locationFacts = (row) => {
  assert.ok(row && typeof row === 'object', '库位拒绝后必须存在原记录')
  return Object.fromEntries(Object.keys(row).sort().map((key) => [key, row[key]]))
}

const recordCheck = (record, name, passed, details) =>
  record.checks.push({ name, passed, details })

export async function hydrateWarehouseFixture (api, record, fixture) {
  const id = String(fixture.warehouse.id)
  const owned = record.fixtures?.find((row) => row.kind === 'warehouse' && String(row.id) === id)
  assert.ok(owned?.code && owned.token === fixture.token, '仓库详情回读必须匹配本轮登记的 ID 和 token')
  const warehouse = dataOf(await api.getBusiness(
    `/mes/wmsWareHouse/queryById?id=${encodeURIComponent(id)}`
  ))
  assert.ok(warehouse && String(warehouse.id) === id &&
    warehouse.code === owned.code && warehouse.mark?.includes(fixture.token),
  '仓库详情编码和所有权必须与本轮创建登记一致')
  return { ...fixture, warehouse: { ...warehouse, id } }
}

export async function verifyCrossWarehouseCodes (api, record, source, target) {
  const name = `E2E-WMS scope ${source.token}`
  await api.postBusiness('/mes/wmsHouseArea/add', {
    areaCode: source.area.areaCode,
    areaName: name,
    houseId: String(target.warehouse.id),
    isEnabled: true,
    remark: `${WMS_FIXTURE_MARK} ${source.token}`
  })
  const areaPage = dataOf(await api.getBusiness(
    `/mes/wmsHouseArea/list?pageNo=1&pageSize=100&houseId=${target.warehouse.id}`
  ))
  const area = (areaPage.records || areaPage.list).find((row) =>
    row.areaCode === source.area.areaCode && String(row.houseId) === String(target.warehouse.id))
  assert.ok(area?.id, '跨仓同编码库区必须回读真实主键')
  record.fixtures = [...(record.fixtures || []), {
    kind: 'area', id: String(area.id), code: source.area.areaCode, token: source.token
  }]
  const locationId = String(dataOf(await api.postBusiness('/mes/wms-house-location/create', {
    locationCode: source.location.locationCode,
    locationName: name,
    houseId: String(target.warehouse.id),
    areaId: String(area.id),
    locationType: 1,
    isEnabled: true,
    remark: `${WMS_FIXTURE_MARK} ${source.token}`
  })))
  record.fixtures.push({
    kind: 'location', id: locationId, code: source.location.locationCode, token: source.token
  })
  const location = dataOf(await api.getBusiness(locationPath(locationId)))
  const original = dataOf(await api.getBusiness(locationPath(source.location.id)))
  recordCheck(record, '同编码跨仓库区库位可分别建档且归属隔离',
    String(area.houseId) === String(target.warehouse.id) &&
      String(location?.houseId) === String(target.warehouse.id) &&
      String(location?.areaId) === String(area.id) &&
      String(original?.houseId) === String(source.warehouse.id) &&
      String(original?.areaId) === String(source.area.id) &&
      String(location?.id) !== String(original?.id) &&
      location?.locationCode === original?.locationCode,
    JSON.stringify({
      sourceWarehouse: source.warehouse.id, targetWarehouse: target.warehouse.id,
      originalLocation: source.location.id, duplicateCodeLocation: locationId
    }))
}

export async function verifyCrossAreaRejection (api, record, fixture, other) {
  const id = String(fixture.location.id)
  const before = locationFacts(dataOf(await api.getBusiness(locationPath(id))))
  const contract = { code: 1001001006, message: '库位所属库区与仓库不一致' }
  const response = await api.put('/mes/wms-house-location/update', {
    id,
    locationCode: fixture.location.locationCode,
    locationName: fixture.location.locationName,
    houseId: String(fixture.warehouse.id),
    areaId: String(other.area.id),
    locationType: 1,
    isEnabled: true
  }, { expectedBusinessRejection: contract })
  const after = locationFacts(dataOf(await api.getBusiness(locationPath(id))))
  recordCheck(record, '空库位跨仓库区归属调整精确领域拒绝且原值不变',
    matchesExpectedBusinessRejection(response, contract) &&
      JSON.stringify(before) === JSON.stringify(after),
    `location=${id}; code=${response.code}; message=${response.msg || response.message}`)
}

export async function verifyLocationOccupied (api, record, fixture, target, label) {
  const before = locationFacts(dataOf(await api.getBusiness(locationPath(fixture.location.id))))
  const deletion = await api.delete(
    `/mes/wms-house-location/delete?id=${encodeURIComponent(fixture.location.id)}`,
    { expectedBusinessRejection: inUse }
  )
  const afterDeletion = locationFacts(dataOf(await api.getBusiness(locationPath(fixture.location.id))))
  recordCheck(record, `${label}：删除领域拒绝且库位原值不变`,
    matchesExpectedBusinessRejection(deletion, inUse) &&
      JSON.stringify(before) === JSON.stringify(afterDeletion),
    JSON.stringify({ code: deletion.code, message: deletion.msg || deletion.message, id: before.id }))
  const movement = await api.put('/mes/wms-house-location/update', {
    id: String(fixture.location.id),
    locationCode: fixture.location.locationCode,
    locationName: fixture.location.locationName,
    houseId: String(target.warehouse.id),
    areaId: String(target.area.id),
    isEnabled: true,
    locationType: 1
  }, { expectedBusinessRejection: inUse })
  const afterMovement = locationFacts(dataOf(await api.getBusiness(locationPath(fixture.location.id))))
  recordCheck(record, `${label}：移动领域拒绝且库位原值不变`,
    matchesExpectedBusinessRejection(movement, inUse) &&
      JSON.stringify(before) === JSON.stringify(afterMovement),
    JSON.stringify({ code: movement.code, message: movement.msg || movement.message, id: before.id }))
}

export async function verifyLocationReferenceClosure (api, record, target) {
  const inventoryFixture = await prepareWmsFixture(api, record, 41)
  const opening = await createOpeningInventory(
    api, record, inventoryFixture, inventoryFixture.material, inventoryFixture.unit.id, 1
  )
  const inventory = await inventorySnapshot(api, inventoryFixture, inventoryFixture.material.id)
  recordCheck(record, '库存占用：正式期初生效且精确库位库存为一',
    opening.approved && inventory.some((row) =>
      String(row.wareLocationId) === String(inventoryFixture.location.id) && Number(row.qty) === 1),
    `opening=${opening.id}; location=${inventoryFixture.location.id}`)
  if (!opening.approved) throw new Error('库存占用前置期初未生效，不能用未完成单据替代库存占用')
  await verifyLocationOccupied(api, record, inventoryFixture, target, '库存占用')

  // Packing uses a separate location with no inventory or stock-IO document.
  const packingFixture = await prepareWmsFixture(api, record, 42)
  const emptyInventory = await inventorySnapshot(api, packingFixture, packingFixture.material.id)
  assert.equal(emptyInventory.length, 0, '装箱专属库位不能同时存在库存，避免混淆引用来源')
  const code = fixtureCode(packingFixture.token, 'PKG', 1)
  const id = String(dataOf(await api.postBusiness('/mes/wms/packing/create', {
    code,
    remark: `${WMS_FIXTURE_MARK} ${packingFixture.token}`,
    lines: [{
      itemId: String(packingFixture.material.id),
      warehouseId: String(packingFixture.warehouse.id),
      areaId: String(packingFixture.area.id),
      locationId: String(packingFixture.location.id),
      unitId: String(packingFixture.unit.id),
      batchNo: `${packingFixture.token}-PACK`,
      quantity: 1
    }]
  })))
  assert.match(id, /^[1-9]\d*$/, '草稿装箱必须回读合法主键')
  try {
    const packing = dataOf(await api.getBusiness(`/mes/wms/packing/get?id=${id}`))
    recordCheck(record, '装箱占用：独立空库存库位绑定未完成装箱草稿',
      String(packing?.id) === id && packing.code === code &&
        Number(packing.status) === 0 && packing.remark.includes(packingFixture.token) &&
        packing.lines.some((line) => String(line.locationId) === String(packingFixture.location.id)),
      `package=${id}; location=${packingFixture.location.id}; inventoryRows=${emptyInventory.length}`)
    await verifyLocationOccupied(api, record, packingFixture, target, '装箱占用')
  } finally {
    const packing = dataOf(await api.getBusiness(`/mes/wms/packing/get?id=${id}`))
    assert.equal(packing?.code, code, '清理草稿装箱前必须匹配专属箱码')
    assert.ok(packing?.remark?.includes(packingFixture.token), '清理草稿装箱前必须匹配本轮 token')
    assert.equal(Number(packing.status), 0, '只允许清理本轮未完成装箱草稿')
    await api.deleteBusiness(`/mes/wms/packing/delete?id=${id}`)
    const rows = dataOf(await api.getBusiness(
      `/mes/wms/packing/page?code=${encodeURIComponent(code)}&withLines=true&pageSize=100`
    ))
    recordCheck(record, '装箱占用：正式删除后精确箱码回读无活动记录',
      Array.isArray(rows) && rows.every((row) => String(row.id) !== id), `package=${id}; code=${code}`)
  }
  return { inventoryFixture: await hydrateWarehouseFixture(api, record, inventoryFixture), packingFixture }
}
