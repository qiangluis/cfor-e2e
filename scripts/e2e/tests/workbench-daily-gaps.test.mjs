import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  createWorkbenchDailyReport,
  inspectWorkbenchDailyGap,
  prepareWorkbenchDailyProject,
  readWorkbenchPmReference
} from '../fixtures/workbench-daily-gaps.mjs'
import { dailyGapConclusion } from '../workbenchhelper/contracts.mjs'
import { createOwnedRegistry } from '../workbenchhelper/owned.mjs'

const marker = 'E2E_PB113_001_PROJECT-UNIT'
const reference = { projectId: '101', handoverId: '102', marker }
const success = (data) => ({ code: 0, data })
function fixture ({ foreign = true, member = false, corrupt = false } = {}) {
  const calls = []
  const get = async (query) => {
    calls.push(query)
    if (query.startsWith('/pm/project/get')) return success({
      id: '101', handoverId: '102', projectName: corrupt ? 'old-business' : marker
    })
    if (query.startsWith('/pm/handover/get')) return success({
      projectId: '101', projectName: marker
    })
    if (query.startsWith('/pm/project-role/list')) return success([
      { id: '104', userId: member ? '103' : '1', status: 'ACTIVE' }
    ])
    assert.match(query, /projectId=101/)
    assert.match(query, /pageSize=100/)
    const rows = foreign && query.includes('WEEKLY')
      ? [{ id: '105', projectId: '101', reporterId: '1', reportType: 'WEEKLY', status: 'REJECTED' }] : []
    return success({ list: rows, total: rows.length })
  }
  return { calls, adminApi: { get }, ownApi: { get } }
}

test('PM reference IDs require this round formal creation and ownership evidence', () => {
  fs.mkdirSync('/tmp/cfor-e2e', { recursive: true })
  const root = fs.mkdtempSync('/tmp/cfor-e2e/continue-20261013-project-unit-')
  const filename = `${root}/result.json`
  const result = { cases: [{
    id: 'PB113-001', startedAt: '2026-10-13T07:12:12Z',
    checks: [{ name: '本轮专属项目归属、状态与原计划日期回读不变', passed: true }],
    evidence: [`创建并回读本轮专属空项目 projectId=101, handoverId=102, marker=${marker}`]
  }] }
  try {
    fs.writeFileSync(filename, JSON.stringify(result))
    assert.equal(readWorkbenchPmReference(filename).projectId, '101')
    result.cases[0].checks[0].passed = false
    fs.writeFileSync(filename, JSON.stringify(result))
    assert.throws(() => readWorkbenchPmReference(filename))
    result.cases[0].checks[0].passed = true
    result.cases[0].startedAt = '2026-10-12T00:00:00Z'
    fs.writeFileSync(filename, JSON.stringify(result))
    assert.throws(() => readWorkbenchPmReference(filename))
  } finally { fs.rmSync(root, { recursive: true }) }
})

test('daily gap uses only scoped reads and records visibility without choosing a policy', async () => {
  const f = fixture()
  const observation = await inspectWorkbenchDailyGap({ ...f, reference, userId: '103' })
  assert.equal(observation.writePerformed, false)
  assert.equal(observation.foreignReportsVisible.length, 1)
  assert.equal(observation.pages.selfDaily.total, 0)
  assert.ok(f.calls.filter((query) => query.includes('/page')).every((query) => query.includes('projectId=101')))
  assert.ok(f.calls.some((query) => query.includes('reporterId=103')))
})

test('member or ownership mismatch stops before report queries', async () => {
  for (const options of [{ member: true }, { corrupt: true }]) {
    const f = fixture(options)
    await assert.rejects(inspectWorkbenchDailyGap({ ...f, reference, userId: '103' }))
    assert.ok(!f.calls.some((query) => query.includes('/page')))
  }
})

test('business rejection and foreign IDs cannot become successful evidence', async () => {
  const f = fixture()
  await assert.rejects(inspectWorkbenchDailyGap({
    ...f, ownApi: { get: async () => ({ code: 403, msg: 'denied' }) }, reference, userId: '103'
  }))
  await assert.rejects(inspectWorkbenchDailyGap({
    ...f, ownApi: { get: async () => success({ total: 1, list: [{
      id: '999', projectId: '999', reporterId: '103', reportType: 'DAILY'
    }] }) }, reference, userId: '103'
  }))
})

test('formal PM write payloads preserve large Snowflake IDs as strings', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-15T12:00:00') })
  const accountId = '2110538109578686466'
  const handoverId = '2110538111059275777'
  const projectId = '2110538112000000001'
  const roleId = '2110538113000000001'
  const assignmentBodies = []
  const adminApi = {
    async getBusiness (pathname) {
      if (pathname === '/system/user/profile/get') {
        return success({ id: '1' })
      }
      if (pathname.startsWith('/pm/modeling/list?')) {
        return success([{ configCode: 'DIGITAL' }])
      }
      if (pathname === `/pm/project/get?id=${projectId}`) {
        return success({ id: projectId, handoverId, customerNameSnapshot: marker })
      }
      if (pathname === `/pm/project-role/list?projectId=${projectId}`) {
        return success([{ id: roleId, userId: accountId, roleCode: 'REPORTER', status: 'ACTIVE' }])
      }
      assert.fail(`Unexpected admin GET ${pathname}`)
    },
    async postBusiness (pathname) {
      assert.equal(pathname, '/pm/handover/create')
      return success(handoverId)
    },
    async putBusiness (pathname, body) {
      if (pathname.startsWith('/pm/handover/submit?')) return success(true)
      if (pathname === '/pm/handover/review') return success(projectId)
      if (pathname === '/pm/project-role/assign') {
        assignmentBodies.push(body)
        return success(roleId)
      }
      assert.fail(`Unexpected admin PUT ${pathname}`)
    }
  }
  await prepareWorkbenchDailyProject({
    adminApi,
    account: { userId: accountId },
    marker,
    caseRecord: { evidence: [], notes: [], businessIds: [] }
  })
  assert.deepEqual(assignmentBodies, [{
    projectId,
    userId: accountId,
    roleCode: 'REPORTER',
    effectiveStart: '2026-10-15',
    sourceType: 'MANUAL',
    sourceId: handoverId
  }])

  const draftId = '2110538114000000001'
  const draftBodies = []
  let draftStatus = 'DRAFT'
  const ownApi = {
    async postBusiness (pathname, body) {
      assert.equal(pathname, '/pm/daily-report/save-draft')
      draftBodies.push(body)
      return success(draftId)
    },
    async getBusiness (pathname) {
      if (pathname === `/pm/daily-report/get?id=${draftId}`) {
        return success({
          id: draftId,
          projectId,
          reporterId: accountId,
          status: draftStatus,
          sourceSnapshotJson: '{"generatedAt":"2026-10-15T00:00:00Z"}'
        })
      }
      assert.fail(`Unexpected owned GET ${pathname}`)
    },
    async putBusiness (pathname) {
      assert.equal(pathname, `/pm/daily-report/submit?id=${draftId}`)
      draftStatus = 'SUBMITTED'
      return success(true)
    }
  }
  const pageApi = {
    async getBusiness (pathname) {
      assert.ok(pathname.includes(`/pm/daily-report/page?pageNo=1&pageSize=100&projectId=${projectId}`))
      return success({ list: [{
        id: draftId, projectId, reporterId: accountId, status: 'SUBMITTED'
      }] })
    }
  }
  const reportState = {}
  await createWorkbenchDailyReport({
    adminApi: pageApi,
    ownApi,
    account: { userId: accountId, state: reportState },
    fixture: { projectId },
    marker,
    caseRecord: { checks: [], businessIds: [], fixtureResiduals: [] },
    periodKey: '2026-10-15'
  })
  assert.equal(draftBodies[0].projectId, projectId)
  assert.equal(draftBodies[0].reporterId, accountId)
  assert.equal(reportState.hasRetainedReports, true)
})

for (const failure of ['handover-submit', 'project-read', 'role-read', 'role-mismatch']) {
  test(`PM creation IDs are audited before ${failure} and owned roles remain cleanable`, async () => {
    const ownedMarker = 'E2E-WBF-004-AUDIT'
    const caseRecord = { checks: [], notes: [], evidence: [] }
    const registry = createOwnedRegistry(ownedMarker, caseRecord)
    const calls = []
    let role
    let roleReads = 0
    const audited = (type, value) => caseRecord.businessIds?.some((row) =>
      row.type === type && row.id === value && row.marker === ownedMarker)
    const adminApi = {
      async getBusiness (pathname) {
        calls.push(`GET ${pathname}`)
        if (pathname === '/system/user/profile/get') return success({ id: '1' })
        if (pathname.startsWith('/pm/modeling/list?')) return success([{ configCode: 'DIGITAL' }])
        if (pathname === '/pm/project/get?id=102') {
          assert.ok(audited('pm-project', '102'))
          assert.ok(caseRecord.fixtureResiduals.some((row) => row.type === 'pm-project' && row.id === '102'))
          if (failure === 'project-read') throw new Error(failure)
          return success({ id: '102', handoverId: '101', customerNameSnapshot: ownedMarker })
        }
        assert.equal(pathname, '/pm/project-role/list?projectId=102')
        assert.ok(audited('pm-project-role', '104'))
        assert.equal(registry.entries.length, 1, 'Cleanup must precede the first role read')
        roleReads++
        if (roleReads === 1 && failure === 'role-read') throw new Error(failure)
        if (roleReads === 1 && failure === 'role-mismatch') {
          return success([{ ...role, userId: '999' }])
        }
        return success([role])
      },
      async postBusiness (pathname) {
        calls.push(`POST ${pathname}`)
        assert.equal(pathname, '/pm/handover/create')
        return success('101')
      },
      async putBusiness (pathname, body) {
        calls.push(`PUT ${pathname}`)
        if (pathname === '/pm/handover/submit?id=101') {
          assert.ok(audited('pm-handover', '101'))
          assert.ok(caseRecord.fixtureResiduals.some((row) => row.type === 'pm-handover' && row.id === '101'))
          if (failure === 'handover-submit') throw new Error(failure)
          return success(true)
        }
        if (pathname === '/pm/handover/review') return success('102')
        if (pathname === '/pm/project-role/assign') {
          role = { ...body, id: '104', status: 'ACTIVE' }
          return success(role.id)
        }
        assert.equal(pathname, '/pm/project-role/end?id=104')
        role.status = 'ENDED'
        return success(true)
      }
    }
    await assert.rejects(prepareWorkbenchDailyProject({
      adminApi, account: { userId: '103' }, marker: ownedMarker, caseRecord, registry
    }), failure === 'role-mismatch' ? assert.AssertionError : new RegExp(failure))
    assert.ok(audited('pm-handover', '101'))
    const roleCreated = failure.startsWith('role-')
    await registry.cleanup()
    assert.deepEqual(caseRecord.fixtureCleanup.remaining, [])
    assert.equal(calls.filter((call) => call === 'PUT /pm/project-role/end?id=104').length,
      roleCreated ? 1 : 0)
    if (roleCreated) {
      assert.equal(role.status, 'ENDED')
      assert.deepEqual(caseRecord.fixtureCleanup.cleaned, [{ type: 'pm-project-role', id: '104' }])
    }
    assert.deepEqual(caseRecord.fixtureResiduals.map((row) => row.type),
      failure === 'handover-submit' ? ['pm-handover'] : ['pm-handover', 'pm-project'])
    assert.equal(caseRecord.checks.length, 0)
  })
}

for (const failure of ['draft-read', 'draft-owner', 'submit', 'submitted-read', 'admin-page']) {
  test(`PM report ID and retained owner survive ${failure}`, async () => {
    const caseRecord = { checks: [], notes: [], evidence: [] }
    const account = { userId: '2110538109578686466', state: {} }
    const projectId = '2110538112000000001'
    const reportId = '2110538114000000001'
    let reads = 0
    const assertTracked = () => {
      assert.equal(account.state.hasResidualReports, true)
      assert.equal(account.state.hasRetainedReports, true)
      assert.equal(caseRecord.businessIds.length, 1)
      assert.equal(caseRecord.businessIds[0].id, reportId)
      assert.equal(caseRecord.businessIds[0].projectId, projectId)
      assert.equal(caseRecord.fixtureResiduals.length, 1)
      assert.equal(caseRecord.fixtureResiduals[0].id, reportId)
      assert.equal(caseRecord.fixtureResiduals[0].reporterId, account.userId)
    }
    const ownApi = {
      async postBusiness (pathname) {
        assert.equal(pathname, '/pm/daily-report/save-draft')
        return success(reportId)
      },
      async getBusiness (pathname) {
        assertTracked()
        assert.equal(pathname, `/pm/daily-report/get?id=${reportId}`)
        reads++
        if ((reads === 1 && failure === 'draft-read') ||
          (reads === 2 && failure === 'submitted-read')) throw new Error(failure)
        return success({
          id: reportId, projectId,
          reporterId: failure === 'draft-owner' ? '999' : account.userId,
          status: reads === 1 ? 'DRAFT' : 'SUBMITTED',
          sourceSnapshotJson: '{"generatedAt":"2026-10-15T00:00:00Z"}'
        })
      },
      async putBusiness (pathname) {
        assertTracked()
        assert.equal(pathname, `/pm/daily-report/submit?id=${reportId}`)
        if (failure === 'submit') throw new Error(failure)
        return success(true)
      }
    }
    await assert.rejects(createWorkbenchDailyReport({
      ownApi, adminApi: { getBusiness: async () => { assertTracked(); throw new Error('admin-page') } },
      account, fixture: { projectId }, marker, caseRecord, periodKey: '2026-10-15'
    }), failure === 'draft-owner' ? assert.AssertionError : new RegExp(failure))
    assertTracked()
    assert.equal(caseRecord.checks.length, 0)
  })
}

test('rejected PM report creation does not register an ID or retain its owner', async () => {
  const caseRecord = { checks: [], notes: [], evidence: [] }
  const account = { userId: '103', state: {} }
  await assert.rejects(createWorkbenchDailyReport({
    ownApi: { postBusiness: async () => ({ code: 403, msg: 'denied' }) },
    adminApi: {}, account, fixture: { projectId: '102' }, marker, caseRecord
  }))
  assert.deepEqual(account.state, {})
  assert.equal(caseRecord.businessIds, undefined)
  assert.equal(caseRecord.fixtureResiduals, undefined)
})

test('all three conclusions remain partial; prior weekly/preference evidence is not reverified', async () => {
  const f = fixture()
  const observation = await inspectWorkbenchDailyGap({ ...f, reference, userId: '103' })
  for (const caseId of ['WBF-004', 'WBF-008', 'WBF-012']) {
    const record = { checks: [], notes: [], evidence: [] }
    const result = dailyGapConclusion(caseId, record, observation)
    assert.equal(result.partial, true)
    assert.equal(result.catalogComplete, false)
    assert.ok(record.catalogAssertions.every((row) => row.status === 'UNVERIFIED'))
    assert.ok(record.acceptanceGapAssertions.every((row) => row.status === 'GAP'))
    assert.match(result.note, /写侧未执行/)
    assert.match(result.note, /WEEKLY=1/)
  }
})
