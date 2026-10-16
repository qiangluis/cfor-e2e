import assert from 'node:assert/strict'
import test from 'node:test'

import { withWmsManualOqcScenario } from '../fixtures/wms-qc-closure.mjs'
import { __internal } from '../fixtures/wms-qc-closure.mjs'

const settings = {
  target: 'local',
  tenantId: '1',
  tenantName: 'CFOR 标准平台',
  apiBase: 'http://127.0.0.1:48083',
  webBase: 'http://127.0.0.1:9151',
  db: { name: 'cfor_admin_standard' }
}

const response = (data, extra = {}) => ({ code: 0, data, ...extra })
const record = () => ({ checks: [], notes: [], evidence: [], fixtures: [] })

test('WMS closure delegates Q001/Q002 to the existing manual OQC scenario', async () => {
  const calls = []
  const value = await withWmsManualOqcScenario({}, record(), async () => 'manual-result', {
    settings,
    withManualOqcScenario: async (...args) => {
      calls.push(args)
      return args[2]()
    }
  })
  assert.equal(value, 'manual-result')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][3].config, settings)
})

test('WMS inspection source accepts MesStkIo and rejects the legacy StkIo:101 value', () => {
  assert.equal(__internal.stockInspectionSource('MesStkIo', '101'), true)
  assert.equal(__internal.stockInspectionSource('MesStkIo:101', '101'), true)
  assert.equal(__internal.stockInspectionSource('StkIo:101', '101'), false)
  assert.equal(__internal.stockInspectionSource('StkIo', '101'), false)
})

test('qualified inbound inspection payload normalizes the source to MesStkIo', () => {
  const payload = __internal.qualifiedInboundPayload({
    detail: {
      id: '101',
      srcBillType: 'MesStkIo:101',
      srcBillId: '202',
      inspectionPlan: '303'
    },
    entries: [{
      id: '404',
      mid: '101',
      srcBillType: 'MesStkIo:101',
      srcBillId: '202',
      srcEntryId: '505',
      qty: 2
    }],
    items: [{
      id: '606',
      mid: '101',
      entryId: '404',
      itemId: '707'
    }]
  }, 2)
  assert.equal(payload.srcBillType, 'MesStkIo')
  assert.equal(payload.qualityInspectionEntryList[0].srcBillType, 'MesStkIo')
  assert.equal(payload.qualityInspectionEntryList[0].srcBillId, '202')
  assert.equal(payload.qualityInspectionEntryList[0].srcEntryId, '505')
})

test('effective inspection is read-only in the normal path and does not call check again', async () => {
  const calls = []
  const caseRecord = record()
  const detail = {
    id: '101',
    billNo: 'WMS-QC-001-INSPECTION',
    isEffective: 1,
    effectiveTime: '2026-10-12 10:00:00',
    actions: { check: false }
  }
  const api = {
    async getBusiness(path) {
      calls.push(['GET', path])
      return response(detail)
    },
    async put() {
      calls.push(['PUT'])
      return response(null)
    }
  }
  const result = await __internal.auditInboundInspectionWhenNeeded(api, caseRecord, detail.id)
  assert.equal(result.skipped, true)
  assert.equal(calls.some(([method]) => method === 'PUT'), false)
  assert.equal(caseRecord.checks.at(-1).passed, true)
})

test('pending inspection is checked only when the server exposes the check action', async () => {
  const calls = []
  const caseRecord = record()
  let effective = false
  const pending = {
    id: '101',
    billNo: 'WMS-QC-001-INSPECTION',
    isEffective: 0,
    effectiveTime: null,
    actions: { check: true }
  }
  const api = {
    async getBusiness(path) {
      calls.push(['GET', path])
      return response(effective ? { ...pending, isEffective: 1, effectiveTime: '2026-10-12 10:01:00' } : pending)
    },
    async put(path, body, options) {
      calls.push(['PUT', path, body, options])
      effective = true
      return response(null)
    }
  }
  const result = await __internal.auditInboundInspectionWhenNeeded(api, caseRecord, pending.id)
  assert.equal(result.skipped, false)
  assert.equal(calls.filter(([method]) => method === 'PUT').length, 1)
  assert.equal(calls.find(([method]) => method === 'PUT')[1], '/mes/quality/qualityInspection/check')
  assert.equal(caseRecord.checks.find((check) => check.name === '质检核批业务请求成功且回读生效').passed, true)
})

test('precise effective-state rejection excludes generic 500 or transport-shaped failures', () => {
  const expected = __internal.inspectionStateRejection({
    billNo: 'WMS-QC-001-INSPECTION'
  })
  assert.equal(__internal.exactStateRejection({
    code: 500,
    data: null,
    message: expected.message
  }, expected), true)
  assert.equal(__internal.exactStateRejection({
    code: 500,
    data: null,
    message: '数据库连接失败'
  }, expected), false)
  assert.equal(__internal.exactStateRejection({
    code: 500,
    data: null,
    message: expected.message,
    success: true
  }, expected), false)
})

test('a failed check request is never converted into a successful audit', async () => {
  const caseRecord = record()
  const detail = {
    id: '101',
    billNo: 'WMS-QC-001-INSPECTION',
    isEffective: 0,
    actions: { check: true }
  }
  const api = {
    async getBusiness() {
      return response(detail)
    },
    async put() {
      return { code: 500, data: null, message: '数据库连接失败' }
    }
  }
  await assert.rejects(
    __internal.auditInboundInspectionWhenNeeded(api, caseRecord, detail.id),
    /质检核批业务失败/
  )
  assert.equal(caseRecord.checks.find((check) => check.name === '质检核批业务请求成功').passed, false)
})
