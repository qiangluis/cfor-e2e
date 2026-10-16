import { randomBytes } from 'node:crypto'

import { isBusinessSuccess } from '../lib/assertions.mjs'
import { matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { observePage } from '../lib/browser.mjs'
import {
  createPmsIsolationTenant,
  retirePmsIsolationTenant
} from './pms-tenant-isolation.mjs'
import { withDedicatedTenant } from './init-gaps.mjs'

export const WMS_HOUSE_LOCATION_NOT_EXISTS = Object.freeze({
  code: 1001001000,
  message: '库位管理不存在'
})

const fixtureMark = 'E2E WMS tenant isolation fixture'
const legacyNotFound = Object.freeze({
  code: 500,
  message: '未找到对应数据',
  allowServiceCode: true
})

const dataOf = (response) =>
  response && typeof response === 'object' && Object.prototype.hasOwnProperty.call(response, 'data')
    ? response.data
    : response

const numericId = (value, label) => {
  const text = String(value ?? '')
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`BLOCKED: ${label}未返回合法 ID`)
  return text
}

const requireText = (value, label) => {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`BLOCKED: ${label}不能为空`)
  return text
}

const addCheck = (caseRecord, name, passed, details) => {
  caseRecord.checks = [...(caseRecord.checks || []), { name, passed: Boolean(passed), details }]
  return Boolean(passed)
}

const addEvidence = (caseRecord, text) => {
  caseRecord.evidence = [...(caseRecord.evidence || []), text]
}

const warehousesByName = (rows, name, found = []) => {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (String(row?.name) === name) found.push(row)
    warehousesByName(row?.children, name, found)
  }
  return found
}

const listRows = (response, label) => {
  if (!isBusinessSuccess(response)) throw new Error(`${label}读取失败`)
  const data = dataOf(response)
  const rows = Array.isArray(data) ? data : data?.records ?? data?.list
  if (!Array.isArray(rows)) throw new Error(`${label}未返回数组`)
  return rows
}

const ownedCodes = (tenant1Fixture, codes = {}) => {
  const warehouseCode = requireText(codes.warehouseCode ?? tenant1Fixture?.warehouse?.code, '仓库编码')
  const areaCode = requireText(codes.areaCode ?? tenant1Fixture?.area?.areaCode ?? tenant1Fixture?.area?.code, '库区编码')
  const locationCode = requireText(codes.locationCode ?? tenant1Fixture?.location?.locationCode ?? tenant1Fixture?.location?.code, '库位编码')
  return { warehouseCode, areaCode, locationCode }
}

const tenant1Location = (tenant1Fixture) => ({
  id: numericId(tenant1Fixture?.location?.id, '租户1库位 ID'),
  locationCode: requireText(tenant1Fixture?.location?.locationCode ?? tenant1Fixture?.location?.code, '租户1库位编码'),
  locationName: requireText(tenant1Fixture?.location?.locationName ?? tenant1Fixture?.location?.name, '租户1库位名称'),
  warehouseId: numericId(tenant1Fixture?.warehouse?.id, '租户1仓库 ID'),
  areaId: numericId(tenant1Fixture?.area?.id, '租户1库区 ID')
})

const secondTenantPayloads = (codes, suffix) => ({
  warehouse: {
    code: codes.warehouseCode,
    name: `E2E WMS ISO warehouse ${suffix}`,
    mark: `${fixtureMark} ${suffix}`,
    pid: '0',
    isEnabled: true,
    areaEnabled: true,
    locationEnabled: true,
    countInAvailable: true
  },
  area: {
    areaCode: codes.areaCode,
    areaName: `E2E WMS ISO area ${suffix}`,
    isEnabled: true,
    remark: `${fixtureMark} ${suffix}`
  },
  location: {
    locationCode: codes.locationCode,
    locationName: `E2E WMS ISO location ${suffix}`,
    isEnabled: true,
    locationType: 1,
    remark: `${fixtureMark} ${suffix}`
  }
})

const ownedFixture = (marker, payloads) => ({
  marker,
  payloads,
  warehouse: null,
  area: null,
  location: null
})

const objectEquals = (left, right) => String(left ?? '') === String(right ?? '')

const ownershipContracts = (fixture) => [
  {
    label: '库位',
    fixture: fixture.location,
    getPath: (id) => `/mes/wms-house-location/get?id=${encodeURIComponent(id)}`,
    deletePath: (id) => `/mes/wms-house-location/delete?id=${encodeURIComponent(id)}`,
    matches: (row) => objectEquals(row?.locationCode, fixture.payloads.location.locationCode) &&
      objectEquals(row?.houseId, fixture.warehouse?.id) &&
      objectEquals(row?.areaId, fixture.area?.id) &&
      objectEquals(row?.remark, `${fixtureMark} ${fixture.marker}`)
  },
  {
    label: '库区',
    fixture: fixture.area,
    getPath: (id) => `/mes/wmsHouseArea/queryById?id=${encodeURIComponent(id)}`,
    deletePath: (id) => `/mes/wmsHouseArea/delete?id=${encodeURIComponent(id)}`,
    matches: (row) => objectEquals(row?.areaCode, fixture.payloads.area.areaCode) &&
      objectEquals(row?.houseId, fixture.warehouse?.id) &&
      objectEquals(row?.remark, `${fixtureMark} ${fixture.marker}`)
  },
  {
    label: '仓库',
    fixture: fixture.warehouse,
    getPath: (id) => `/mes/wmsWareHouse/queryById?id=${encodeURIComponent(id)}`,
    deletePath: (id) => `/mes/wmsWareHouse/delete?id=${encodeURIComponent(id)}`,
    matches: (row) => objectEquals(row?.code, fixture.payloads.warehouse.code) &&
      objectEquals(row?.name, fixture.payloads.warehouse.name) &&
      objectEquals(row?.mark, fixture.payloads.warehouse.mark)
  }
]

const removedByReadback = (response, expectedMissing) =>
  (isBusinessSuccess(response) && dataOf(response) == null) ||
  (expectedMissing && matchesExpectedBusinessRejection(response, expectedMissing))

/**
 * Create same-code WMS warehouse, area, and location in a real second tenant.
 * The caller supplies the tenant-1 fixture and code triplet so this helper never
 * reads or changes shared tenant-1 WMS master data.
 */
export async function createSecondTenantWmsFixture (api, caseRecord, codes, { suffix } = {}) {
  const marker = suffix || randomBytes(5).toString('hex').toUpperCase()
  const payloads = secondTenantPayloads(codes, marker)
  const owned = ownedFixture(marker, payloads)
  try {
    await api.postBusiness('/mes/wmsWareHouse/add', payloads.warehouse)
    const tree = dataOf(await api.getBusiness('/mes/wmsWareHouse/allTree'))
    const candidates = warehousesByName(Array.isArray(tree) ? tree : tree?.list, payloads.warehouse.name)
    if (candidates.length !== 1) {
      throw new Error(`第二租户专属仓库名称回读不唯一：name=${payloads.warehouse.name}; count=${candidates.length}`)
    }
    const warehouseId = numericId(candidates[0]?.id, '第二租户仓库')
    owned.warehouse = { id: warehouseId }
    const warehouse = dataOf(await api.getBusiness(
      `/mes/wmsWareHouse/queryById?id=${encodeURIComponent(warehouseId)}`
    ))
    if (!ownershipContracts(owned).at(-1).matches(warehouse)) {
      throw new Error(`第二租户同编码仓库精确回读不一致：${codes.warehouseCode}`)
    }
    owned.warehouse = { id: warehouseId, code: String(warehouse.code), name: String(warehouse.name) }

    await api.postBusiness('/mes/wmsHouseArea/add', {
      ...payloads.area,
      houseId: owned.warehouse.id
    })
    const areas = listRows(await api.getBusiness(
      `/mes/wmsHouseArea/list?pageNo=1&pageSize=100&houseId=${encodeURIComponent(owned.warehouse.id)}`
    ), '第二租户库区')
    const matchedAreas = areas.filter((row) => String(row?.areaCode) === codes.areaCode)
    if (matchedAreas.length !== 1) {
      throw new Error(`第二租户同编码库区回读不唯一：${codes.areaCode}; count=${matchedAreas.length}`)
    }
    const areaId = numericId(matchedAreas[0]?.id, '第二租户库区')
    owned.area = { id: areaId }
    const area = dataOf(await api.getBusiness(
      `/mes/wmsHouseArea/queryById?id=${encodeURIComponent(areaId)}`
    ))
    if (!ownershipContracts(owned)[1].matches(area)) {
      throw new Error(`第二租户同编码库区精确回读不一致：${codes.areaCode}`)
    }
    owned.area = { id: areaId, code: String(area.areaCode), warehouseId: String(area.houseId) }

    const locationId = numericId(dataOf(await api.postBusiness('/mes/wms-house-location/create', {
      ...payloads.location,
      houseId: owned.warehouse.id,
      areaId: owned.area.id
    })), '第二租户库位')
    owned.location = { id: locationId }
    const location = dataOf(await api.getBusiness(
      `/mes/wms-house-location/get?id=${encodeURIComponent(locationId)}`
    ))
    if (!ownershipContracts(owned)[0].matches(location)) {
      throw new Error(`第二租户同编码库位精确回读不一致：${codes.locationCode}`)
    }
    owned.location = {
      id: locationId,
      code: String(location.locationCode),
      warehouseId: String(location.houseId),
      areaId: String(location.areaId)
    }
    addEvidence(caseRecord,
      `第二租户同编码 WMS 主数据已创建并回读：warehouse=${owned.warehouse.id}; area=${owned.area.id}; location=${owned.location.id}`)
    return owned
  } catch (error) {
    try {
      await cleanupSecondTenantWmsFixture(api, owned, caseRecord)
    } catch (cleanupError) {
      throw new Error(`${error.message}; 部分 WMS 夹具清理失败：${cleanupError.message}`)
    }
    throw error
  }
}

export async function cleanupSecondTenantWmsFixture (api, fixture, caseRecord) {
  if (!fixture) return
  const errors = []
  for (const item of ownershipContracts(fixture)) {
    const id = item.fixture?.id
    if (!id) continue
    try {
      const before = dataOf(await api.getBusiness(item.getPath(id)))
      if (!item.matches(before)) {
        throw new Error(`所有权不匹配，拒绝删除 id=${id}`)
      }
      await api.deleteBusiness(item.deletePath(id))
      const expectedMissing = item.label === '库位' ? undefined : legacyNotFound
      const after = await api.get(item.getPath(id), expectedMissing
        ? { expectedBusinessRejection: expectedMissing }
        : undefined)
      const removed = removedByReadback(after, expectedMissing)
      addCheck(caseRecord, `清理：第二租户自有${item.label}删除后不可再读取`, removed,
        `id=${id}; code=${after?.code}; message=${after?.msg || after?.message || ''}; ` +
        `data=${after?.data == null ? 'null' : 'present'}`)
      if (!removed) throw new Error(`删除后仍可读取 id=${id}`)
    } catch (error) {
      errors.push(`${item.label} ${id}: ${error.message}`)
    }
  }
  if (errors.length) {
    addCheck(caseRecord, '清理：第二租户自有 WMS 仓库/库区/库位', false, errors.join('；'))
    throw new Error(`第二租户 WMS 夹具清理失败：${errors.join('；')}`)
  }
  addEvidence(caseRecord, '清理：已删除第二租户自有 WMS 库位、库区和仓库')
}

/**
 * Verifies WMS location isolation with a real second-tenant login. The second
 * tenant inherits only an isolated package derived from standard package 111.
 */
export async function verifyWmsTenantIsolation ({
  context,
  api,
  caseRecord,
  tenant1Fixture,
  codes,
  dependencies = {}
}) {
  if (!context?.page || !context?.record) throw new Error('BLOCKED: WMS 租户隔离需要真实主会话 context.page/context.record')
  if (!api?.postBusiness || !api?.getBusiness) throw new Error('BLOCKED: WMS 租户隔离需要租户1正式 API 客户端')
  if (!caseRecord) throw new Error('BLOCKED: WMS 租户隔离需要 caseRecord')

  const tenantOne = tenant1Location(tenant1Fixture)
  const sameCodes = ownedCodes(tenant1Fixture, codes)
  if (sameCodes.locationCode !== tenantOne.locationCode) {
    throw new Error('BLOCKED: 第二租户库位编码必须与 tenant1Fixture 的专属库位编码一致')
  }

  const createTenant = dependencies.createTenant || createPmsIsolationTenant
  const retireTenant = dependencies.retireTenant || retirePmsIsolationTenant
  const withTenant = dependencies.withTenant || withDedicatedTenant
  const createWmsFixture = dependencies.createWmsFixture || createSecondTenantWmsFixture
  const cleanupWmsFixture = dependencies.cleanupWmsFixture || cleanupSecondTenantWmsFixture
  const observe = dependencies.observePage || observePage
  const suffix = String(codes?.marker || randomBytes(5).toString('hex')).replace(/[^A-Za-z0-9]/g, '').slice(-10)

  let tenantFixture
  let operationError
  try {
    try {
      tenantFixture = await createTenant(api, { marker: `WMS004${suffix}` })
    } catch (error) {
      throw new Error(`BLOCKED: 无法创建第二安全测试租户：${error.message}`)
    }

    const result = await withTenant(context, tenantFixture.tenant, async ({ api: tenantApi, auth, page }) => {
      if (String(auth?.tenantId) !== String(tenantFixture.tenantId)) {
        throw new Error(`BLOCKED: 第二租户真实登录身份不一致：${auth?.tenantId} != ${tenantFixture.tenantId}`)
      }
      const capture = observe(page, context.record)
      let fixture
      try {
        fixture = await createWmsFixture(tenantApi, caseRecord, sameCodes, { suffix })
        const isolatedFixture =
          fixture?.warehouse?.code === sameCodes.warehouseCode &&
          fixture?.area?.code === sameCodes.areaCode &&
          fixture?.location?.code === sameCodes.locationCode &&
          String(fixture?.area?.warehouseId) === String(fixture?.warehouse?.id) &&
          String(fixture?.location?.warehouseId) === String(fixture?.warehouse?.id) &&
          String(fixture?.location?.areaId) === String(fixture?.area?.id) &&
          String(fixture?.warehouse?.id) !== tenantOne.warehouseId &&
          String(fixture?.area?.id) !== tenantOne.areaId &&
          String(fixture?.location?.id) !== tenantOne.id
        addCheck(caseRecord, '第二租户同编码仓库库区库位可创建并回读归属隔离', isolatedFixture,
          `tenant=${tenantFixture.tenantId}; ` +
          `warehouse=${fixture?.warehouse?.id}/${fixture?.warehouse?.code}; ` +
          `area=${fixture?.area?.id}/${fixture?.area?.code}->${fixture?.area?.warehouseId}; ` +
          `location=${fixture?.location?.id}/${fixture?.location?.code}->${fixture?.location?.warehouseId}/${fixture?.location?.areaId}; ` +
          `tenant1=${tenantOne.warehouseId}/${tenantOne.areaId}/${tenantOne.id}`)
        if (!isolatedFixture) throw new Error('第二租户同编码 WMS 主数据未形成独立归属记录')
        const foreignGet = await tenantApi.get(
          `/mes/wms-house-location/get?id=${encodeURIComponent(tenantOne.id)}`
        )
        const getHidden = isBusinessSuccess(foreignGet) && foreignGet?.data == null
        addCheck(caseRecord, '第二租户真实登录读取 tenant1 指定库位不可见', getHidden,
          `tenant=${tenantFixture.tenantId}; id=${tenantOne.id}; code=${foreignGet?.code}; data=${foreignGet?.data == null ? 'null' : 'present'}`)
        if (!getHidden) throw new Error('跨租户库位 GET 泄露或未按空结果返回')

        const foreignDelete = await tenantApi.delete(
          `/mes/wms-house-location/delete?id=${encodeURIComponent(tenantOne.id)}`,
          { expectedBusinessRejection: WMS_HOUSE_LOCATION_NOT_EXISTS }
        )
        const deleteRejected = matchesExpectedBusinessRejection(foreignDelete, WMS_HOUSE_LOCATION_NOT_EXISTS)
        addCheck(caseRecord, '第二租户删除 tenant1 指定库位返回精确 NOT_EXISTS 领域错误', deleteRejected,
          `code=${foreignDelete?.code}; message=${foreignDelete?.msg || foreignDelete?.message}`)
        if (!deleteRejected) throw new Error('跨租户库位 DELETE 未返回 WMS_HOUSE_LOCATION_NOT_EXISTS')

        const foreignUpdate = await tenantApi.put('/mes/wms-house-location/update', {
          id: tenantOne.id,
          locationCode: tenantOne.locationCode,
          locationName: tenantOne.locationName,
          houseId: tenantOne.warehouseId,
          areaId: tenantOne.areaId,
          isEnabled: true,
          locationType: 1
        }, { expectedBusinessRejection: WMS_HOUSE_LOCATION_NOT_EXISTS })
        const updateRejected = matchesExpectedBusinessRejection(foreignUpdate, WMS_HOUSE_LOCATION_NOT_EXISTS)
        addCheck(caseRecord, '第二租户更新 tenant1 指定库位返回精确 NOT_EXISTS 领域错误', updateRejected,
          `code=${foreignUpdate?.code}; message=${foreignUpdate?.msg || foreignUpdate?.message}`)
        if (!updateRejected) throw new Error('跨租户库位 UPDATE 未返回 WMS_HOUSE_LOCATION_NOT_EXISTS')

        return {
          tenantId: String(tenantFixture.tenantId),
          sameCodes,
          fixture,
          errors: {
            get: { code: foreignGet?.code, data: foreignGet?.data },
            delete: { code: foreignDelete?.code, message: foreignDelete?.msg || foreignDelete?.message },
            update: { code: foreignUpdate?.code, message: foreignUpdate?.msg || foreignUpdate?.message }
          }
        }
      } finally {
        let cleanupError
        try {
          if (fixture) await cleanupWmsFixture(tenantApi, fixture, caseRecord)
        } catch (error) {
          cleanupError = error
        }
        try {
          await tenantApi.postBusiness('/system/auth/logout')
          addEvidence(caseRecord, `清理：第二租户 ${tenantFixture.tenantId} 本轮 token 已退出`)
        } catch (error) {
          cleanupError = cleanupError || error
        }
        try {
          await capture.flushResponses()
        } catch (error) {
          cleanupError = cleanupError || error
        }
        if (cleanupError) throw cleanupError
      }
    })
    addEvidence(caseRecord,
      `WMS 跨租户验证完成：真实登录 tenant=${result.tenantId}；` +
      `DELETE/UPDATE 均为 ${WMS_HOUSE_LOCATION_NOT_EXISTS.code}`)
    return result
  } catch (error) {
    operationError = error
    throw error
  } finally {
    if (tenantFixture) {
      let retirementError
      try {
        await retireTenant(api, tenantFixture, caseRecord)
      } catch (error) {
        retirementError = error
      }
      const failed = (caseRecord.checks || []).find((item) =>
        item.name === '清理：停用 PMS 专属租户与套餐' && item.passed === false)
      if (failed) {
        retirementError = retirementError || new Error(`第二租户退役失败：${failed.details}`)
      }
      if (retirementError) {
        if (operationError) {
          throw new Error(`${operationError.message}; 第二租户退役失败：${retirementError.message}`)
        }
        throw retirementError
      }
    }
  }
}
