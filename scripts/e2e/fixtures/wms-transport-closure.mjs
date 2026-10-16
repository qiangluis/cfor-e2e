import { randomUUID } from 'node:crypto'

import { matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'

const MARK = 'E2E WMS transport closure'

export const transportRejections = Object.freeze({
  invalidDriver: { code: 2040100000, message: '员工不存在' },
  carrierDisabled: { code: 1001003008, message: '承运商已停用' },
  carrierRoleRequired: { code: 1001003009, message: '统一客商未启用承运商角色' },
  duplicateVehicleNo: { code: 500, message: /^车牌号已存在：/, allowServiceCode: true }
})

export const wmsQc007Mapping = Object.freeze({
  assertions: [
    {
      assertion: '主/副司机必须为有效 HRM 员工，非法员工编号被后端拒绝',
      checks: ['运输车辆非法主司机返回员工不存在', '运输车辆非法副司机返回员工不存在']
    },
    {
      assertion: '承运商必须启用承运商角色且状态为 ACTIVE，否则被后端拒绝',
      checks: ['未启用承运商角色的统一客商返回精确领域拒绝', '停用承运商返回精确领域拒绝']
    },
    {
      assertion: '车牌号在租户范围内唯一',
      checks: ['同一租户重复车牌返回精确领域拒绝且原车辆快照不变', '重复车牌拒绝后原运输车辆完整快照不变']
    },
    {
      assertion: '分页与详情回填承运商名称和司机姓名',
      checks: ['运输车辆分页与详情回读承运商和主副司机快照一致']
    },
    {
      assertion: 'ERP 销售发货单可选择启用的运输车辆，并保存车牌和主司机姓名快照',
      checks: ['ERP 销售发货草稿回读车辆承运商和主司机快照', '停用专属车辆不回写历史发货草稿快照']
    }
  ],
  acceptanceGaps: []
})

const dataOf = (response) => response?.data
const text = (value) => String(value ?? '').trim()
const same = (left, right) => text(left) === text(right)
const addCheck = (record, name, passed, details) => {
  record.checks = [...(record.checks || []), { name, passed: Boolean(passed), details }]
  return Boolean(passed)
}
const requireCheck = (record, name, passed, details) => {
  if (!addCheck(record, name, passed, details)) throw new Error(`${name}: ${details}`)
}
const pageRows = (response, label) => {
  if (!isBusinessSuccess(response)) throw new Error(`${label}读取失败`)
  const data = dataOf(response)
  const rows = Array.isArray(data?.list) ? data.list : data?.records
  if (!Array.isArray(rows)) throw new Error(`${label}未返回数组`)
  return rows
}
const uniqueId = (value, label) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error(`${label}返回不安全数字 ID，必须使用字符串`)
  }
  const id = text(value)
  if (!/^\d+$/.test(id) || id === '0') throw new Error(`${label}未返回合法 ID`)
  return id
}
const canonical = (value) => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
    : item)
const integerOrNull = (value) => Number.isSafeInteger(value) ? value : null

const vehicleSnapshot = (row) => ({
  id: text(row?.id), vehicleNo: text(row?.vehicleNo), vehicleType: text(row?.vehicleType),
  loadCapacity: row?.loadCapacity, volumeCapacity: row?.volumeCapacity,
  ownOrgId: text(row?.ownOrgId), ownershipType: text(row?.ownershipType), status: integerOrNull(row?.status),
  licenseExpireDate: text(row?.licenseExpireDate), carrierPartnerId: text(row?.carrierPartnerId),
  carrierPartnerName: text(row?.carrierPartnerName), mainDriverId: text(row?.mainDriverId),
  mainDriverName: text(row?.mainDriverName), assistantDriverId: text(row?.assistantDriverId),
  assistantDriverName: text(row?.assistantDriverName), remark: text(row?.remark)
})

const deliverySnapshot = (row) => ({
  id: text(row?.id), billNo: text(row?.billNo), remark: text(row?.remark),
  customerId: text(row?.customerId), vehicleId: text(row?.vehicleId), vehicleNo: text(row?.vehicleNo),
  driverName: text(row?.driverName), carrierPartnerId: text(row?.carrierPartnerId),
  carrierPartnerName: text(row?.carrierPartnerName), billStage: text(row?.billStage),
  isEffective: integerOrNull(row?.isEffective), isVoided: integerOrNull(row?.isVoided),
  items: (row?.saleDeliveryItemsDOList || row?.items || []).map((item) => ({
    id: text(item?.id), entryNo: integerOrNull(item?.entryNo),
    materialId: text(item?.materialId), materialUnitId: text(item?.materialUnitId),
    deliveryCount: item?.deliveryCount, productPrice: item?.productPrice, totalPrice: item?.totalPrice,
    remark: text(item?.remark)
  })).sort((left, right) => left.id.localeCompare(right.id))
})

const partnerSnapshot = (row) => ({
  id: text(row?.id), name: text(row?.name), partnerKind: text(row?.partnerKind), status: text(row?.status),
  customerEnabled: Boolean(row?.customerEnabled), supplierEnabled: Boolean(row?.supplierEnabled),
  carrierEnabled: Boolean(row?.carrierEnabled), remark: text(row?.remark)
})

const completePartner = (row) => {
  const partner = partnerSnapshot(row)
  return /^\d+$/.test(partner.id) && partner.id !== '0' && Boolean(partner.name) &&
    Boolean(partner.partnerKind) && Boolean(partner.status) && Boolean(partner.remark)
}
const completeVehicle = (row) => {
  const vehicle = vehicleSnapshot(row)
  return /^\d+$/.test(vehicle.id) && vehicle.id !== '0' && Boolean(vehicle.vehicleNo) &&
    [0, 1].includes(vehicle.status) && Boolean(vehicle.ownershipType) &&
    Boolean(vehicle.carrierPartnerId) && Boolean(vehicle.carrierPartnerName) &&
    Boolean(vehicle.mainDriverId) && Boolean(vehicle.mainDriverName) && Boolean(vehicle.remark)
}
const completeDelivery = (row) => {
  const delivery = deliverySnapshot(row)
  return /^\d+$/.test(delivery.id) && delivery.id !== '0' && Boolean(delivery.billNo) &&
    Boolean(delivery.remark) && Boolean(delivery.customerId) && Boolean(delivery.vehicleId) &&
    Boolean(delivery.vehicleNo) && Boolean(delivery.driverName) && Boolean(delivery.carrierPartnerId) &&
    Boolean(delivery.carrierPartnerName) && Number.isSafeInteger(delivery.isEffective) &&
    Number.isSafeInteger(delivery.isVoided) && delivery.items.length === 1 &&
    Number.isSafeInteger(delivery.items[0].entryNo) &&
    /^\d+$/.test(delivery.items[0].materialId) && /^\d+$/.test(delivery.items[0].materialUnitId)
}

const vehicleBody = (vehicle, status = vehicle.status) => ({
  id: vehicle.id, vehicleNo: vehicle.vehicleNo, vehicleType: vehicle.vehicleType || undefined,
  loadCapacity: vehicle.loadCapacity, volumeCapacity: vehicle.volumeCapacity,
  ownOrgId: vehicle.ownOrgId || undefined, ownershipType: vehicle.ownershipType || undefined,
  status, licenseExpireDate: vehicle.licenseExpireDate || undefined,
  carrierPartnerId: vehicle.carrierPartnerId || undefined, mainDriverId: vehicle.mainDriverId || undefined,
  assistantDriverId: vehicle.assistantDriverId || undefined, remark: vehicle.remark || undefined
})

const partnerBody = (token, kind, options = {}) => ({
  name: `E2E-QC007-${kind}-${token}`,
  shortName: `QC007${kind}`.slice(0, 100),
  partnerKind: 'ORGANIZATION', status: options.status || 'ACTIVE',
  customerEnabled: options.customerEnabled === true, supplierEnabled: false,
  carrierEnabled: options.carrierEnabled === true, remark: `${MARK} ${token} ${kind}`
})

const ownPartner = (row, expected) => completePartner(row) && completePartner(expected) &&
  canonical(partnerSnapshot(row)) === canonical(partnerSnapshot(expected))
const ownVehicle = (row, expected) => completeVehicle(row) && completeVehicle(expected) &&
  canonical(vehicleSnapshot(row)) === canonical(vehicleSnapshot(expected))
const ownDelivery = (row, expected) => completeDelivery(row) && completeDelivery(expected) &&
  canonical(deliverySnapshot(row)) === canonical(deliverySnapshot(expected))

const getOne = async (api, path, label) => {
  const response = await api.getBusiness(path)
  const data = dataOf(response)
  if (!data || typeof data !== 'object') throw new Error(`${label}详情为空`)
  return data
}

const findVehicles = async (api, vehicleNo) => pageRows(
  await api.getBusiness(`/wms/transport-vehicle/page?pageNo=1&pageSize=100&vehicleNo=${encodeURIComponent(vehicleNo)}`),
  '运输车辆分页'
).filter((row) => same(row?.vehicleNo, vehicleNo))

const findDeliveries = async (api, billNo) => pageRows(
  await api.getBusiness(`/erp/sale-delivery/page?pageNo=1&pageSize=100&billNo=${encodeURIComponent(billNo)}`),
  '销售发货单分页'
).filter((row) => same(row?.billNo, billNo))

const addMappedAssertions = (caseRecord) => {
  caseRecord.catalogAssertions = wmsQc007Mapping.assertions.map((item, index) => {
    const checks = item.checks.map((name) => caseRecord.checks.find((check) => check.name === name))
    const passed = checks.length > 0 && checks.every((check) => check?.passed === true)
    return {
      index, assertion: item.assertion, status: passed ? 'VERIFIED' : 'GAP', evidenceChecks: item.checks,
      details: passed ? checks.map((check) => check.details).join('; ') : '本轮没有形成完整、精确的写侧证据'
    }
  })
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((item) => item.status === 'GAP').map((item) => item.assertion)
  return caseRecord.remainingAssertions
}

/**
 * Delete only resources created by this helper. Every delete is guarded by a
 * complete server read-back and followed by an exact page/get absence check.
 */
export async function cleanupWmsTransportClosure (api, fixture, caseRecord) {
  const errors = []
  const attempt = async (label, run) => {
    try {
      await run()
      return true
    } catch (error) {
      errors.push(`${label}: ${error.message}`)
      return false
    }
  }
  const deliveryClean = !fixture.delivery || await attempt('销售发货草稿清理', async () => {
    const before = await getOne(api, `/erp/sale-delivery/get?id=${encodeURIComponent(fixture.delivery.id)}`, '清理前销售发货草稿')
    if (!ownDelivery(before, fixture.delivery)) throw new Error('销售发货草稿所有权或完整快照不匹配')
    await api.deleteBusiness(`/erp/sale-delivery/delete?id=${encodeURIComponent(fixture.delivery.id)}`)
    const rows = await findDeliveries(api, fixture.delivery.billNo)
    requireCheck(caseRecord, '专属销售发货草稿删除后分页不可见', rows.length === 0,
      `billNo=${fixture.delivery.billNo}; rows=${rows.length}`)
  })
  const vehicleClean = !fixture.vehicle || (deliveryClean && await attempt('运输车辆清理', async () => {
    const before = await getOne(api, `/wms/transport-vehicle/get?id=${encodeURIComponent(fixture.vehicle.id)}`, '清理前运输车辆')
    if (!ownVehicle(before, fixture.vehicle)) throw new Error('运输车辆所有权或完整快照不匹配')
    await api.deleteBusiness(`/wms/transport-vehicle/delete?id=${encodeURIComponent(fixture.vehicle.id)}`)
    const rows = await findVehicles(api, fixture.vehicle.vehicleNo)
    requireCheck(caseRecord, '专属运输车辆删除后分页不可见', rows.length === 0,
      `vehicleNo=${fixture.vehicle.vehicleNo}; rows=${rows.length}`)
  }))
  if (!deliveryClean && fixture.vehicle) errors.push('运输车辆清理跳过：销售发货草稿未确认删除，保留依赖车辆')
  if (!deliveryClean || !vehicleClean) {
    if ((fixture.partners || []).length) errors.push('统一客商清理跳过：发货草稿或车辆未确认删除，保留依赖客商')
  } else for (const partner of [...(fixture.partners || [])].reverse()) await attempt(`客商 ${partner.id} 清理`, async () => {
    const before = await getOne(api, `/base/partner/get?id=${encodeURIComponent(partner.id)}`, '清理前统一客商')
    if (!ownPartner(before, partner)) throw new Error('统一客商所有权或完整快照不匹配')
    await api.deleteBusiness(`/base/partner/delete?id=${encodeURIComponent(partner.id)}`)
    const after = await api.getBusiness(`/base/partner/get?id=${encodeURIComponent(partner.id)}`)
    requireCheck(caseRecord, '专属统一客商删除后详情为空', dataOf(after) == null,
      `partnerId=${partner.id}; data=${JSON.stringify(dataOf(after))}`)
  })
  if (errors.length) throw new Error(`WMS-QC-007 夹具清理失败：${errors.join('；')}`)
}

/**
 * Full write-side closure for WMS-QC-007. It never creates or updates HRM
 * employees or caller-supplied material/unit master data.
 */
export async function verifyWmsTransportClosure ({ api, caseRecord, employee, material, unitId }) {
  const employeeId = uniqueId(employee?.id, '既有 HRM 员工')
  const employeeName = text(employee?.name)
  const materialId = uniqueId(material?.id, '既有物料')
  const resolvedUnitId = uniqueId(unitId || material?.unitId, '既有计量单位')
  if (!employeeName) throw new Error('BLOCKED: 既有 HRM 员工缺姓名，不创建或修改共享员工')
  const token = randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()
  const vehicleNo = `E2E${token}`.slice(0, 32)
  const fixture = { token, vehicleNo, partners: [], vehicle: null, delivery: null }
  const registerPartner = async (kind, options) => {
    const id = uniqueId(dataOf(await api.postBusiness('/base/partner/create', partnerBody(token, kind, options))), '统一客商')
    const detail = await getOne(api, `/base/partner/get?id=${encodeURIComponent(id)}`, '统一客商回读')
    const snapshot = partnerSnapshot(detail)
    if (!completePartner(snapshot) || !same(snapshot.remark, `${MARK} ${token} ${kind}`)) {
      throw new Error(`专属统一客商回读所有权失败：${id}`)
    }
    fixture.partners.push(snapshot)
    return snapshot
  }
  try {
    const carrier = await registerPartner('CARRIER', { carrierEnabled: true })
    const noRole = await registerPartner('NO-ROLE', { carrierEnabled: false, customerEnabled: true })
    const inactive = await registerPartner('INACTIVE', { carrierEnabled: true, status: 'INACTIVE' })
    const customer = await registerPartner('CUSTOMER', { customerEnabled: true })
    const rejected = async (name, body, contract, expectedRows) => {
      const response = await api.post('/wms/transport-vehicle/create', body, { expectedBusinessRejection: contract })
      const rows = await findVehicles(api, body.vehicleNo)
      requireCheck(caseRecord, name, matchesExpectedBusinessRejection(response, contract) && rows.length === expectedRows,
        `code=${response?.code}; message=${response?.msg || response?.message || ''}; rows=${rows.length}`)
    }
    await rejected('运输车辆非法主司机返回员工不存在', {
      vehicleNo: `${vehicleNo}M`, carrierPartnerId: carrier.id, mainDriverId: `INVALID-${token}`, status: 1
    }, transportRejections.invalidDriver, 0)
    await rejected('运输车辆非法副司机返回员工不存在', {
      vehicleNo: `${vehicleNo}A`, carrierPartnerId: carrier.id, mainDriverId: employeeId,
      assistantDriverId: `INVALID-${token}`, status: 1
    }, transportRejections.invalidDriver, 0)
    await rejected('未启用承运商角色的统一客商返回精确领域拒绝', {
      vehicleNo: `${vehicleNo}R`, carrierPartnerId: noRole.id, mainDriverId: employeeId, status: 1
    }, transportRejections.carrierRoleRequired, 0)
    await rejected('停用承运商返回精确领域拒绝', {
      vehicleNo: `${vehicleNo}I`, carrierPartnerId: inactive.id, mainDriverId: employeeId, status: 1
    }, transportRejections.carrierDisabled, 0)
    const vehicleId = uniqueId(dataOf(await api.postBusiness('/wms/transport-vehicle/create', {
      vehicleNo, vehicleType: 'TRUCK', loadCapacity: 10, volumeCapacity: 30, ownershipType: 'OWN', status: 1,
      carrierPartnerId: carrier.id, mainDriverId: employeeId, remark: `${MARK} ${token}`
    })), '专属运输车辆')
    const vehicle = vehicleSnapshot(await getOne(api,
      `/wms/transport-vehicle/get?id=${encodeURIComponent(vehicleId)}`, '专属运输车辆详情'))
    if (!completeVehicle(vehicle)) throw new Error(`专属运输车辆详情不完整：${vehicleId}`)
    fixture.vehicle = vehicle
    const pageRowsForVehicle = await findVehicles(api, vehicleNo)
    requireCheck(caseRecord, '运输车辆分页与详情回读承运商和主副司机快照一致',
      pageRowsForVehicle.length === 1 && ownVehicle(pageRowsForVehicle[0], vehicle) &&
      vehicle.carrierPartnerId === carrier.id && vehicle.carrierPartnerName === carrier.name &&
      vehicle.mainDriverId === employeeId && vehicle.mainDriverName === employeeName &&
      vehicle.assistantDriverId === '' && vehicle.assistantDriverName === '',
      `vehicle=${vehicle.id}; carrier=${vehicle.carrierPartnerName}; mainDriver=${vehicle.mainDriverName}`)
    await rejected('同一租户重复车牌返回精确领域拒绝且原车辆快照不变', {
      vehicleNo, carrierPartnerId: carrier.id, mainDriverId: employeeId, status: 1
    }, transportRejections.duplicateVehicleNo, 1)
    const unchanged = vehicleSnapshot(await getOne(api,
      `/wms/transport-vehicle/get?id=${encodeURIComponent(vehicleId)}`, '重复车牌后原车辆详情'))
    requireCheck(caseRecord, '重复车牌拒绝后原运输车辆完整快照不变', canonical(unchanged) === canonical(vehicle),
      `vehicle=${vehicleId}`)
    const billNo = `E2E-QC007-${token}-DELIVERY`
    await api.postBusiness('/erp/sale-delivery/add-draft', {
      billNo, billDate: new Date().toISOString().slice(0, 10), subject: billNo, customerId: customer.id,
      deliveryTime: new Date().toISOString().slice(0, 19).replace('T', ' '), deliveryCount: 1,
      deliveryMethod: '物流', vehicleId, carrierPartnerId: carrier.id, expressCode: 'SF',
      remark: `${MARK} ${token} delivery`, saleDeliveryItemsDOList: [{
        entryNo: 1, materialId, materialUnitId: resolvedUnitId,
        deliveryCount: 1, productPrice: 1, totalPrice: 1,
        remark: `${MARK} ${token} delivery line`
      }]
    })
    const deliveryRows = await findDeliveries(api, billNo)
    if (deliveryRows.length !== 1) throw new Error(`专属销售发货草稿回读不唯一：billNo=${billNo}; count=${deliveryRows.length}`)
    const deliveryId = uniqueId(deliveryRows[0]?.id, '专属销售发货草稿')
    const delivery = deliverySnapshot(await getOne(api,
      `/erp/sale-delivery/get?id=${encodeURIComponent(deliveryId)}`, '专属销售发货草稿详情'))
    if (!completeDelivery(delivery)) throw new Error(`专属销售发货草稿详情不完整：${deliveryId}`)
    fixture.delivery = delivery
    requireCheck(caseRecord, 'ERP 销售发货草稿回读车辆承运商和主司机快照',
      delivery.vehicleId === vehicleId && delivery.vehicleNo === vehicleNo && delivery.driverName === employeeName &&
      delivery.carrierPartnerId === carrier.id && delivery.carrierPartnerName === carrier.name &&
      delivery.customerId === customer.id && delivery.billNo === billNo && delivery.items.length === 1 &&
      delivery.items[0].materialId === materialId && delivery.items[0].materialUnitId === resolvedUnitId,
      `delivery=${deliveryId}; vehicle=${delivery.vehicleNo}; driver=${delivery.driverName}; carrier=${delivery.carrierPartnerName}`)
    let vehicleDisabled = false
    try {
      await api.putBusiness('/wms/transport-vehicle/update', vehicleBody(vehicle, 0))
      vehicleDisabled = true
      const disabledDelivery = deliverySnapshot(await getOne(api,
        `/erp/sale-delivery/get?id=${encodeURIComponent(deliveryId)}`, '停用车辆后销售发货草稿详情'))
      requireCheck(caseRecord, '停用专属车辆不回写历史发货草稿快照', canonical(disabledDelivery) === canonical(delivery),
        `delivery=${deliveryId}; vehicle=${vehicleId}`)
    } finally {
      if (vehicleDisabled) {
        await api.putBusiness('/wms/transport-vehicle/update', vehicleBody(vehicle, 1))
        const restored = vehicleSnapshot(await getOne(api,
          `/wms/transport-vehicle/get?id=${encodeURIComponent(vehicleId)}`, '恢复专属运输车辆详情'))
        requireCheck(caseRecord, '专属运输车辆状态恢复后完整快照不变', canonical(restored) === canonical(vehicle),
          `vehicle=${vehicleId}`)
      }
    }
    addMappedAssertions(caseRecord)
    return { covered: caseRecord.remainingAssertions.length === 0, fixture, remainingAssertions: caseRecord.remainingAssertions }
  } finally {
    await cleanupWmsTransportClosure(api, fixture, caseRecord)
  }
}

export const __internal = {
  canonical, uniqueId, vehicleSnapshot, deliverySnapshot, partnerSnapshot,
  completePartner, completeVehicle, completeDelivery, ownPartner, ownVehicle, ownDelivery, addMappedAssertions
}
