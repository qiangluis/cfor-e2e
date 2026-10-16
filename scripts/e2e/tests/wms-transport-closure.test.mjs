import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { matchesExpectedBusinessRejection } from '../lib/api.mjs'
import {
  __internal, cleanupWmsTransportClosure, transportRejections, wmsQc007Mapping
} from '../fixtures/wms-transport-closure.mjs'

test('WMS-QC-007 uses exact contracts for drivers, carrier role/status, and duplicate plate', () => {
  const accepted = [
    [{ code: 2040100000, msg: '员工不存在' }, transportRejections.invalidDriver],
    [{ code: 1001003008, msg: '承运商已停用' }, transportRejections.carrierDisabled],
    [{ code: 1001003009, msg: '统一客商未启用承运商角色' }, transportRejections.carrierRoleRequired],
    [{ code: 500, msg: '车牌号已存在：E2E123' }, transportRejections.duplicateVehicleNo]
  ]
  for (const [response, contract] of accepted) assert.equal(matchesExpectedBusinessRejection(response, contract), true)
  assert.equal(matchesExpectedBusinessRejection({ code: 500, msg: '系统异常' }, transportRejections.duplicateVehicleNo), false)
  assert.equal(matchesExpectedBusinessRejection({ code: 2040100000, msg: '其他员工错误' }, transportRejections.invalidDriver), false)
})

test('ownership snapshots include all mutable transport and delivery identity fields', () => {
  const vehicle = __internal.vehicleSnapshot({
    id: '1', vehicleNo: 'E2E1', vehicleType: 'TRUCK', loadCapacity: 10, volumeCapacity: 20,
    ownershipType: 'OWN', status: 1, carrierPartnerId: '2', carrierPartnerName: '承运商',
    mainDriverId: '3', mainDriverName: '主司机', assistantDriverId: '4', assistantDriverName: '副司机', remark: 'marker'
  })
  assert.equal(__internal.ownVehicle({ ...vehicle }, vehicle), true)
  assert.equal(__internal.ownVehicle({ ...vehicle, carrierPartnerName: '其他承运商' }, vehicle), false)
  const delivery = __internal.deliverySnapshot({
    id: '5', billNo: 'D1', customerId: '6', vehicleId: '1', vehicleNo: 'E2E1', driverName: '主司机',
    carrierPartnerId: '2', carrierPartnerName: '承运商', remark: 'marker', isEffective: 0, isVoided: 0,
    saleDeliveryItemsDOList: [{ id: '7', entryNo: 1, materialId: '8', materialUnitId: '9', deliveryCount: 1, productPrice: 1, totalPrice: 1 }]
  })
  assert.equal(__internal.ownDelivery({ ...delivery }, delivery), true)
  assert.equal(__internal.ownDelivery({ ...delivery, driverName: '其他司机' }, delivery), false)
  assert.equal(__internal.ownDelivery({ ...delivery, items: [{ ...delivery.items[0], entryNo: 2 }] }, delivery), false)
  assert.equal(__internal.ownDelivery({ ...delivery, items: [{ ...delivery.items[0], totalPrice: 2 }] }, delivery), false)
  assert.equal(__internal.completeDelivery({ ...delivery, items: [] }), false)
})

test('uniqueId rejects an unsafe numeric identifier but preserves a string identifier', () => {
  assert.equal(__internal.uniqueId('9007199254740993', 'ID'), '9007199254740993')
  assert.throws(() => __internal.uniqueId(9007199254740993, 'ID'), /不安全数字 ID/)
})

test('cleanup deletes only complete owned snapshots and proves page/detail absence', async () => {
  const calls = []
  let partnerDeleted = false
  const fixture = {
    delivery: { id: '11', billNo: 'D11', remark: 'm', customerId: '4', vehicleId: '10', vehicleNo: 'V10', driverName: '司机', carrierPartnerId: '1', carrierPartnerName: '承运商', billStage: '', isEffective: 0, isVoided: 0, items: [{ id: '12', entryNo: 1, materialId: '8', materialUnitId: '9', deliveryCount: 1, productPrice: 1, totalPrice: 1, remark: 'line' }] },
    vehicle: { id: '10', vehicleNo: 'V10', vehicleType: 'TRUCK', loadCapacity: 10, volumeCapacity: 20, ownOrgId: '', ownershipType: 'OWN', status: 1, licenseExpireDate: '', carrierPartnerId: '1', carrierPartnerName: '承运商', mainDriverId: '2', mainDriverName: '司机', assistantDriverId: '', assistantDriverName: '', remark: 'v' },
    partners: [{ id: '1', name: '承运商', partnerKind: 'ORGANIZATION', status: 'ACTIVE', customerEnabled: false, supplierEnabled: false, carrierEnabled: true, remark: 'p' }]
  }
  const api = {
    async getBusiness (path) {
      calls.push(['GET', path])
      if (path === '/erp/sale-delivery/get?id=11') return { code: 0, data: fixture.delivery }
      if (path.startsWith('/erp/sale-delivery/page')) return { code: 0, data: { list: [] } }
      if (path === '/wms/transport-vehicle/get?id=10') return { code: 0, data: fixture.vehicle }
      if (path.startsWith('/wms/transport-vehicle/page')) return { code: 0, data: { list: [] } }
      if (path === '/base/partner/get?id=1') return { code: 0, data: partnerDeleted ? null : fixture.partners[0] }
      throw new Error(`unexpected ${path}`)
    },
    async deleteBusiness (path) {
      calls.push(['DELETE', path])
      if (path === '/base/partner/delete?id=1') partnerDeleted = true
      return { code: 0, data: true }
    }
  }
  const record = { checks: [] }
  await cleanupWmsTransportClosure(api, fixture, record)
  assert.deepEqual(calls.filter(([method]) => method === 'DELETE').map(([, path]) => path), [
    '/erp/sale-delivery/delete?id=11', '/wms/transport-vehicle/delete?id=10', '/base/partner/delete?id=1'
  ])
  assert.equal(record.checks.every((check) => check.passed), true)
})

test('cleanup refuses an unowned resource before any delete', async () => {
  const calls = []
  const fixture = {
    delivery: null,
    vehicle: { id: '10', vehicleNo: 'V10', vehicleType: 'TRUCK', loadCapacity: 10, volumeCapacity: 20, ownOrgId: '', ownershipType: 'OWN', status: 1, licenseExpireDate: '', carrierPartnerId: '1', carrierPartnerName: '承运商', mainDriverId: '2', mainDriverName: '司机', assistantDriverId: '', assistantDriverName: '', remark: 'owned' },
    partners: []
  }
  const api = {
    async getBusiness () {
      return { code: 0, data: { ...fixture.vehicle, remark: 'foreign' } }
    },
    async deleteBusiness (path) { calls.push(path); return { code: 0, data: true } }
  }
  await assert.rejects(() => cleanupWmsTransportClosure(api, fixture, { checks: [] }), /所有权或完整快照不匹配/)
  assert.deepEqual(calls, [])
})

test('cleanup retains dependent vehicle and partners when delivery cleanup cannot be proven', async () => {
  const calls = []
  const fixture = {
    delivery: { id: '11', billNo: 'D11', remark: 'm', customerId: '4', vehicleId: '10', vehicleNo: 'V10', driverName: '司机', carrierPartnerId: '1', carrierPartnerName: '承运商', billStage: '', isEffective: 0, isVoided: 0, items: [{ id: '12', entryNo: 1, materialId: '8', materialUnitId: '9', deliveryCount: 1, productPrice: 1, totalPrice: 1, remark: 'line' }] },
    vehicle: { id: '10', vehicleNo: 'V10', vehicleType: 'TRUCK', loadCapacity: 10, volumeCapacity: 20, ownOrgId: '', ownershipType: 'OWN', status: 1, licenseExpireDate: '', carrierPartnerId: '1', carrierPartnerName: '承运商', mainDriverId: '2', mainDriverName: '司机', assistantDriverId: '', assistantDriverName: '', remark: 'v' },
    partners: [{ id: '1', name: '承运商', partnerKind: 'ORGANIZATION', status: 'ACTIVE', customerEnabled: false, supplierEnabled: false, carrierEnabled: true, remark: 'p' }]
  }
  const api = {
    async getBusiness (path) {
      if (path === '/erp/sale-delivery/get?id=11') return { code: 0, data: { ...fixture.delivery, remark: 'foreign' } }
      throw new Error(`unexpected ${path}`)
    },
    async deleteBusiness (path) { calls.push(path); return { code: 0, data: true } }
  }
  await assert.rejects(() => cleanupWmsTransportClosure(api, fixture, { checks: [] }), /销售发货草稿清理/)
  assert.deepEqual(calls, [])
})

test('catalog mapping retains all original assertions and explicitly has no acceptance gaps', () => {
  assert.equal(wmsQc007Mapping.assertions.length, 5)
  assert.deepEqual(wmsQc007Mapping.acceptanceGaps, [])
  assert.deepEqual(wmsQc007Mapping.assertions[2].checks, [
    '同一租户重复车牌返回精确领域拒绝且原车辆快照不变',
    '重复车牌拒绝后原运输车辆完整快照不变'
  ])
  const source = fs.readFileSync(new URL('../fixtures/wms-transport-closure.mjs', import.meta.url), 'utf8')
  assert.match(source, /非法副司机/)
  assert.match(source, /停用专属车辆不回写历史发货草稿快照/)
  assert.match(source, /专属运输车辆删除后分页不可见/)
})
