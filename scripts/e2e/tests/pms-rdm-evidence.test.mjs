import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  RDM_UNTESTED_STEPS,
  runRdmEvidenceContract
} from '../suites/pms-rdm.mjs'

const ok = (data) => ({ code: 0, data })
const paged = (rows) => ok({ list: rows, total: rows.length })
const record = () => ({ checks: [], notes: [], evidence: [] })

const baseRows = {
  'RDM-001': [{ id: 1, status: 'DRAFT', reviewConclusion: null, reviewReason: null }],
  'RDM-002': [{ id: 2, status: 'PENDING_EXECUTION', releaseCondition: null }],
  'RDM-003': [{ id: 3, status: 'RUNNING' }],
  'RDM-004': [{
    id: 4,
    iterationId: 5,
    impactTest: 'test',
    impactMaterial: 'material',
    impactDelivery: 'delivery',
    impactCost: 'cost',
    targetScopeJson: '{"scope":["A"]}',
    approvedSnapshotId: null
  }],
  'RDM-005': [{ id: 6, ebomId: 6, versionNo: 'V1', lineCount: 1 }],
  'RDM-006': [{ id: 7, versionNo: 'V1' }]
}

const paths = {
  'RDM-001': '/pm/requirement/page?pageNo=1&pageSize=100',
  'RDM-002': '/pm/task/page?pageNo=1&pageSize=100',
  'RDM-003': '/plm/rdm/project/ledger/page?pageNo=1&pageSize=100',
  'RDM-004': '/pm/change/page?pageNo=1&pageSize=100',
  'RDM-005': '/plm/core/ebom/page?pageNo=1&pageSize=100',
  'RDM-006': '/pm/release/page?pageNo=1&pageSize=100'
}

function fixture (caseId, rows = baseRows[caseId], overrides = {}) {
  const responses = {
    [paths[caseId]]: paged(rows),
    '/plm/core/ebom/tree?ebomId=6': ok([{
      parentId: 6,
      componentPartId: 60,
      componentRevisionId: 600,
      approvalStatus: null,
      effectiveDate: null,
      expiryDate: null,
      children: []
    }]),
    '/plm/rdm/record/page?bizTypes=APPROVAL&pageNo=1&pageSize=100': paged([{
      id: 8,
      bizType: 'APPROVAL',
      planId: 80,
      runId: 800
    }]),
    '/pm/release/gate?id=7': ok({
      releaseId: 7,
      requirementCoverage: null,
      criticalBugOpenCount: 0,
      verificationConclusion: null,
      artifactFrozen: false,
      passed: false,
      blockReasons: ['验证结论未填写']
    })
  }
  Object.assign(responses, overrides)
  const calls = []
  return {
    calls,
    api: {
      async getBusiness (path) {
        calls.push(path)
        assert.ok(Object.hasOwn(responses, path), `unexpected GET ${path}`)
        return structuredClone(responses[path])
      }
    }
  }
}

async function run (caseId, rows, overrides) {
  const f = fixture(caseId, rows, overrides)
  const caseRecord = record()
  const result = await runRdmEvidenceContract({ caseId, api: f.api, caseRecord })
  return { ...f, result, caseRecord }
}

for (const caseId of Object.keys(RDM_UNTESTED_STEPS)) {
  test(`${caseId} always reports partial and names untested write evidence`, async () => {
    const { result, caseRecord } = await run(caseId)
    assert.equal(result.partial, true)
    assert.match(result.note, /未测步骤/)
    assert.ok(caseRecord.notes.some((note) => note.startsWith('PARTIAL：')))
  })
}

for (const caseId of Object.keys(RDM_UNTESTED_STEPS)) {
  test(`${caseId} empty page records a prerequisite gap without empty field/state/gate pass`, async () => {
    const overrides = caseId === 'RDM-005'
      ? { '/plm/rdm/record/page?bizTypes=APPROVAL&pageNo=1&pageSize=100': paged([]) }
      : undefined
    const { result, calls, caseRecord } = await run(caseId, [], overrides)
    assert.equal(result.partial, true)
    assert.ok(caseRecord.notes.some((note) => note.startsWith('缺前置：')))
    assert.ok(!caseRecord.checks.some((check) =>
      /reviewConclusion|releaseCondition|状态|影响评估|approvedSnapshotId|approvalStatus|planId\/runId|发布门禁/.test(check.name)
    ))
    assert.ok(!calls.some((path) => path.includes('/gate')))
  })
}

test('RDM-001 accepts null reviewConclusion/reviewReason because the response VO permits empty values', async () => {
  const { caseRecord } = await run('RDM-001')
  const check = caseRecord.checks.find((item) => item.name.includes('reviewConclusion'))
  assert.equal(check?.passed, true)
})

test('RDM-001 rejects a response missing a real review field', async () => {
  const { caseRecord } = await run('RDM-001', [{ id: 1, reviewConclusion: null }])
  const check = caseRecord.checks.find((item) => item.name.includes('reviewConclusion'))
  assert.equal(check?.passed, false)
})

test('RDM-004 accepts null approvedSnapshotId before approval and requires the real VO field', async () => {
  const valid = await run('RDM-004')
  const validCheck = valid.caseRecord.checks.find((item) => item.name.includes('approvedSnapshotId'))
  assert.equal(validCheck?.passed, true)

  const missingField = { ...baseRows['RDM-004'][0] }
  delete missingField.approvedSnapshotId
  const invalid = await run('RDM-004', [missingField])
  const invalidCheck = invalid.caseRecord.checks.find((item) => item.name.includes('approvedSnapshotId'))
  assert.equal(invalidCheck?.passed, false)
})

test('RDM-005 validates approval fields from tree rows, not version-summary rows', async () => {
  const { calls, caseRecord } = await run('RDM-005', [{
    ...baseRows['RDM-005'][0],
    approvalStatus: undefined,
    effectiveDate: undefined,
    expiryDate: undefined
  }])
  assert.ok(calls.includes('/plm/core/ebom/tree?ebomId=6'))
  const check = caseRecord.checks.find((item) => item.name.includes('EBOM 树行'))
  assert.equal(check?.passed, true)
})

test('RDM-006 calls the pure GET gate only after a release row with an id exists', async () => {
  const { calls, caseRecord } = await run('RDM-006')
  assert.ok(calls.includes('/pm/release/gate?id=7'))
  assert.ok(caseRecord.checks.some((item) => item.name.includes('发布门禁')))

  const empty = await run('RDM-006', [])
  assert.ok(!empty.calls.some((path) => path.includes('/gate')))
})

test('RDM evidence contract contains no write API or business-text logging', () => {
  const source = fs.readFileSync(new URL('../suites/pms-rdm.mjs', import.meta.url), 'utf8')
  const contract = source.slice(
    source.indexOf('export const runRdmEvidenceContract'),
    source.indexOf('export const runCase')
  )
  assert.doesNotMatch(contract, /api\.(post|put|delete|upload|request)|\/(create|save|update|status|transition|release-to-mes)/)
  assert.doesNotMatch(contract, /console\.(log|error|warn)|innerText|textContent/)
  assert.match(contract, /partial: true/)
})
