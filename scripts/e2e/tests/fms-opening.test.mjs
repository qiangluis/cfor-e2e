import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanOpeningBatch, openingDateMatches, recordFms005Acceptance } from '../suites/fms.mjs'

test('openingDateMatches accepts the backend LocalDate array response', () => {
  assert.equal(openingDateMatches([2026, 10, 6]), true)
  assert.equal(openingDateMatches([2026, 10, 7]), false)
})

test('openingDateMatches accepts the backend ISO date response', () => {
  assert.equal(openingDateMatches('2026-10-06'), true)
  assert.equal(openingDateMatches('2026-10-06T00:00:00'), true)
  assert.equal(openingDateMatches('2026-10-07'), false)
})

test('FMS-005 acceptance mapping closes only when every assertion and reverse has evidence', () => {
  const definition = {
    assertions: [
      '期初批次确认后按客户/供应商汇总生成 FMS 辅助核算期初',
      '同一批次重复投递幂等，不重复累计金额',
      '弃审后对应辅助核算期初金额回零',
      '对账接口返回逐客商状态和合计差异',
      '已发生核销的批次禁止改、弃审和删除'
    ],
    reverse: ['通过往来期初弃审撤销 FMS 汇总；错误调整走受控调整，不直接改科目期初']
  }
  const caseRecord = {
    catalogEvidence: {
      [definition.assertions[0]]: { status: 'PASS', evidence: 'summary evidence' },
      [definition.assertions[4]]: { status: 'PASS', evidence: 'write-off protection evidence' },
      [definition.reverse[0]]: { status: 'PASS', evidence: 'reverse evidence' }
    },
    notes: []
  }
  const result = recordFms005Acceptance(caseRecord, definition)
  assert.equal(result.partial, true)
  assert.equal(result.acceptanceComplete, false)
  assert.equal(caseRecord.passCandidate, false)
  assert.deepEqual(caseRecord.catalogAssertions.map((item) => item.index), [0, 1, 2, 3, 4])
  assert.deepEqual(caseRecord.catalogAssertions.map((item) => item.assertion), definition.assertions)
  assert.deepEqual(caseRecord.catalogAssertions.map((item) => item.status), [
    'VERIFIED', 'GAP', 'GAP', 'GAP', 'VERIFIED'
  ])
  assert.equal(caseRecord.catalogAssertions[4].evidence, 'write-off protection evidence')
  assert.deepEqual(caseRecord.catalogReverseAssertions, [{
    index: 0,
    assertion: definition.reverse[0],
    status: 'VERIFIED',
    evidence: 'reverse evidence'
  }])
  assert.equal(caseRecord.catalogAssertions.some((item) => item.assertion === definition.reverse[0]), false)

  const completeRecord = {
    catalogEvidence: Object.fromEntries([
      ...definition.assertions,
      ...definition.reverse
    ].map((assertion) => [assertion, { status: 'PASS', evidence: `${assertion} evidence` }])),
    checks: definition.assertions.map((assertion) => ({ name: assertion, passed: true })),
    notes: []
  }
  const complete = recordFms005Acceptance(completeRecord, definition)
  assert.equal(complete.partial, false)
  assert.equal(complete.acceptanceComplete, true)
  assert.equal(completeRecord.passCandidate, true)
  assert.equal(completeRecord.remainingAssertions.length, 0)

  const failedRecord = {
    ...completeRecord,
    checks: [{ name: 'cleanup', passed: false }],
    notes: []
  }
  const failed = recordFms005Acceptance(failedRecord, definition)
  assert.equal(failed.partial, true)
  assert.equal(failed.acceptanceComplete, false)
  assert.equal(failedRecord.passCandidate, false)
})

function openingApi ({ effective = false, deleted = false } = {}) {
  const calls = []
  let isDeleted = deleted
  let partnerDeleted = deleted
  let isVoided = false
  const api = {
    calls,
    async getBusiness (pathname) {
      calls.push(['GET', pathname])
      if (pathname.startsWith('/finance/dealingsBeginning/list?')) {
        return { data: isDeleted ? { records: [] } : { records: [{ id: '9001' }] } }
      }
      if (pathname === '/finance/dealingsBeginning/queryById?id=9001') {
        return { data: { id: '9001', isEffective: effective ? 1 : 0, isVoided: isVoided ? 1 : 0 } }
      }
      if (pathname === '/base/partner/get?id=7001') {
        return { data: partnerDeleted ? null : { id: '7001' } }
      }
      throw new Error(`unexpected GET ${pathname}`)
    },
    async putBusiness (pathname, body) {
      calls.push(['PUT', pathname, body])
      assert.equal(pathname, '/finance/dealingsBeginning/void')
      assert.equal(body.id, '9001')
      isVoided = true
      return { code: 200, success: true, data: 'ok' }
    },
    async deleteBusiness (pathname) {
      calls.push(['DELETE', pathname])
      if (pathname.startsWith('/finance/dealingsBeginning/delete?')) isDeleted = true
      if (pathname === '/base/partner/delete?id=7001') partnerDeleted = true
      return { code: 200, success: true, data: 'ok' }
    }
  }
  return api
}

test('cleanup deletes an unapproved opening batch without calling void and confirms absence', async () => {
  const api = openingApi()
  await cleanOpeningBatch(api, {
    billId: '9001', batchNo: 'E2E-AR-UNIT', role: 'receivable', partnerId: '7001'
  })
  assert.equal(api.calls.filter(([method, pathname]) => method === 'PUT' && pathname.endsWith('/void')).length, 0)
  assert.equal(api.calls.filter(([method]) => method === 'DELETE').length, 2)
})

test('cleanup voids an effective opening batch before delete and confirms absence', async () => {
  const api = openingApi({ effective: true })
  await cleanOpeningBatch(api, {
    billId: '9001', batchNo: 'E2E-AR-UNIT', role: 'receivable', partnerId: '7001'
  })
  const methods = api.calls.map(([method]) => method)
  assert.deepEqual(methods, ['GET', 'GET', 'GET', 'PUT', 'GET', 'DELETE', 'GET', 'GET', 'DELETE', 'GET'])
})
