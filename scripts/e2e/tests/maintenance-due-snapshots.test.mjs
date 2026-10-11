import test from 'node:test'
import assert from 'node:assert/strict'
import {
  hasDueTaskSnapshots, hasRecordTaskSnapshots, hasExactMaintenanceReadPermissions,
  createFixtureCleanup, trackMaintenanceProbeSession, trackGeneratedTaskCleanup,
  trackInspectionRuntimePlan
} from '../suites/iot-maintenance.mjs'

const device = { id: '9007199254740993', deviceName: 'E2E owned', productId: '9007199254740995', deviceType: 0 }
const runtime = {
  id: '101', sourcePlanId: '201', sourcePlanVersion: 1, assignmentId: '301',
  configSnapshot: JSON.stringify({ version: 1, items: [{
    itemVersion: 1, standard: 'E2E 目视无异常', resultType: 'BOOLEAN',
    execRequirement: 'E2E 按正式标准检查并记录结果', standardHours: 0.5, attachmentRequired: false
  }] }),
  cycleRuleSnapshot: JSON.stringify({ cycleType: 'TIME', cycleValue: 1, cycleUnit: 'DAY', dataSource: 'CALENDAR' })
}
const task = () => ({
  id: '401', planId: runtime.id, sourcePlanId: runtime.sourcePlanId,
  sourcePlanVersion: runtime.sourcePlanVersion, assignmentId: runtime.assignmentId,
  configSnapshot: runtime.configSnapshot, cycleRuleSnapshot: runtime.cycleRuleSnapshot,
  deviceSnapshot: JSON.stringify([device])
})

test('due task evidence requires exact structured cycle, configured standard and device snapshots', () => {
  assert.equal(hasDueTaskSnapshots(task(), runtime, device), true)
  for (const field of ['configSnapshot', 'cycleRuleSnapshot', 'deviceSnapshot']) {
    for (const value of [null, '', '{}', '[]', '{broken}']) {
      assert.equal(hasDueTaskSnapshots({ ...task(), [field]: value }, runtime, device), false, `${field}:${value}`)
    }
  }
  assert.equal(hasDueTaskSnapshots({ ...task(), assignmentId: '302' }, runtime, device), false)
  assert.equal(hasDueTaskSnapshots({ ...task(), sourcePlanVersion: 2 }, runtime, device), false)
  assert.equal(hasDueTaskSnapshots(task(), runtime, { ...device, deviceName: 'another' }), false)
})

test('execution record must inherit all three complete snapshots and the exact source identity', () => {
  const source = task()
  const record = {
    taskId: source.id, maintenancePlanId: source.sourcePlanId,
    maintenancePlanVersion: source.sourcePlanVersion, assignmentId: source.assignmentId,
    configSnapshot: source.configSnapshot, cycleRuleSnapshot: source.cycleRuleSnapshot,
    deviceSnapshot: source.deviceSnapshot
  }
  assert.equal(hasRecordTaskSnapshots(record, source), true)
  for (const field of Object.keys(record)) {
    assert.equal(hasRecordTaskSnapshots({ ...record, [field]: null }, source), false, field)
  }
})

test('permission probes accept empty directory markers but reject every extra grant or write capability', () => {
  const permission = 'mes:maintenance-plan:query'
  const expected = [permission, 'system:settings:query']
  assert.equal(hasExactMaintenanceReadPermissions(['', ...expected], expected, permission), true)
  for (const extra of ['*:*:*', 'mes:maintenance-plan:update', 'mes:maintenance-plan:publish',
    'other:query', null, undefined]) {
    assert.equal(hasExactMaintenanceReadPermissions([...expected, extra], expected, permission), false)
  }
  assert.equal(hasExactMaintenanceReadPermissions(['system:settings:query'], expected, permission), false)
})

test('probe cleanup revokes its exact session before deactivating the account or deleting its role', async () => {
  const caseRecord = { checks: [], notes: [] }
  const fixtures = createFixtureCleanup({ caseId: 'MAINT-005', caseRecord })
  const calls = []
  fixtures.track('11', 'role', async () => calls.push('role'))
  fixtures.track('12', 'user', async () => calls.push('user'))
  trackMaintenanceProbeSession(fixtures, {
    postBusiness: async (path) => {
      assert.equal(path, '/system/auth/logout')
      calls.push('logout')
      return { code: 0, data: true }
    },
    request: async (method, path, body, options) => {
      assert.equal(method, 'GET')
      assert.equal(path, '/system/auth/get-permission-info')
      assert.equal(options.expectedBusinessRejection.code, 401)
      calls.push('revoked')
      return { code: 401, msg: '账号未登录' }
    }
  }, '12')
  await fixtures.cleanup(false)
  assert.deepEqual(calls, ['logout', 'revoked', 'user', 'role'])
  assert.equal(caseRecord.checks.every((item) => item.passed), true)
})

test('probe cleanup fails when logout does not actually revoke the session', async () => {
  const caseRecord = { checks: [], notes: [] }
  const fixtures = createFixtureCleanup({ caseId: 'MAINT-005', caseRecord })
  trackMaintenanceProbeSession(fixtures, {
    postBusiness: async () => ({ code: 0, data: true }),
    request: async () => ({ code: 0, data: {} })
  }, '12')
  await assert.rejects(fixtures.cleanup(false), /测试数据清理失败/)
  assert.equal(caseRecord.checks[0].passed, false)
})

test('failed permission probe cleans generated tasks only inside its previously empty dedicated plan', async () => {
  const caseRecord = { checks: [], notes: [] }
  const fixtures = createFixtureCleanup({ caseId: 'MAINT-005', caseRecord })
  const tasks = [{ id: '401', planId: '101' }]
  trackGeneratedTaskCleanup(fixtures, {
    getBusiness: async (path) => {
      assert.equal(path, '/mes/system/task/list?pageNo=1&pageSize=100&planId=101')
      return { code: 0, data: { list: [...tasks], total: tasks.length } }
    },
    deleteBusiness: async (path) => {
      assert.equal(path, '/mes/system/task/401')
      tasks.splice(0)
      return { code: 0, data: true }
    }
  }, '101')
  await fixtures.cleanup(true)
  assert.equal(tasks.length, 0)
  assert.equal(caseRecord.checks[0].passed, true)
})

test('task fallback cleanup refuses foreign ownership and reports ineffective deletion', async () => {
  for (const planId of ['102', '101']) {
    const caseRecord = { checks: [], notes: [] }
    const fixtures = createFixtureCleanup({ caseId: 'MAINT-005', caseRecord })
    trackGeneratedTaskCleanup(fixtures, {
      getBusiness: async () => ({ code: 0, data: { list: [{ id: '401', planId }], total: 1 } }),
      deleteBusiness: async () => {
        assert.equal(planId, '101', 'must not delete a foreign plan task')
        return { code: 0, data: true }
      }
    }, '101')
    await assert.rejects(fixtures.cleanup(false), /测试数据清理失败/)
    assert.equal(caseRecord.checks[0].passed, false)
  }
})

test('task cleanup continues after a failed deletion and preserves the parent with residual IDs', async () => {
  for (const pageField of ['list', 'records']) {
    const caseRecord = { checks: [], notes: [] }
    const fixtures = createFixtureCleanup({ caseId: 'MAINT-005', caseRecord })
    const tasks = [{ id: '401', planId: '101' }, { id: '402', planId: '101' }]
    const deleted = []
    const api = {
      getBusiness: async () => ({ code: 0, data: { [pageField]: [...tasks], total: tasks.length } }),
      deleteBusiness: async (path) => {
        deleted.push(path)
        if (path === '/mes/system/task/401') throw new Error('simulated deletion failure')
        assert.equal(path, '/mes/system/task/402', 'parent must remain when one task survives')
        tasks.splice(tasks.findIndex((task) => task.id === '402'), 1)
        return { code: 0, data: true }
      }
    }
    trackInspectionRuntimePlan(fixtures, api, '101')
    trackGeneratedTaskCleanup(fixtures, api, '101')
    await assert.rejects(fixtures.cleanup(false), /测试数据清理失败/)
    assert.deepEqual(deleted, ['/mes/system/task/401', '/mes/system/task/402'])
    assert.equal(tasks.length, 1)
    assert.equal(caseRecord.checks.length, 2)
    assert.equal(caseRecord.checks.every((check) => check.passed === false), true)
    assert.match(caseRecord.checks[0].details, /残余任务 id=401 删除失败.*total=1, ids=401/)
    assert.match(caseRecord.checks[1].details, /保留运行计划.*total=1, ids=401/)
  }
})

test('task cleanup reads all pages before deleting and only then removes an empty parent', async () => {
  const caseRecord = { checks: [], notes: [] }
  const fixtures = createFixtureCleanup({ caseId: 'MAINT-005', caseRecord })
  const tasks = Array.from({ length: 205 }, (_, index) => ({ id: String(401 + index), planId: '101' }))
  const pages = []
  let parentDeleted = false
  const api = {
    getBusiness: async (path) => {
      const query = new URL(path, 'http://localhost').searchParams
      assert.equal(query.get('planId'), '101')
      assert.equal(query.get('pageSize'), '100')
      const page = Number(query.get('pageNo'))
      pages.push(page)
      return { code: 0, data: { records: tasks.slice((page - 1) * 100, page * 100), total: tasks.length } }
    },
    deleteBusiness: async (path) => {
      if (path === '/mes/system/plan/101') {
        assert.equal(tasks.length, 0)
        parentDeleted = true
      } else {
        assert.deepEqual(pages.slice(0, 3), [1, 2, 3])
        const index = tasks.findIndex((task) => path === `/mes/system/task/${task.id}`)
        assert.notEqual(index, -1)
        tasks.splice(index, 1)
      }
      return { code: 0, data: true }
    }
  }
  trackInspectionRuntimePlan(fixtures, api, '101')
  trackGeneratedTaskCleanup(fixtures, api, '101')
  await fixtures.cleanup(false)
  assert.equal(parentDeleted, true)
  assert.equal(tasks.length, 0)
  assert.equal(caseRecord.checks.every((check) => check.passed), true)
})

test('later-page foreign tasks, duplicate IDs or changing totals prevent every deletion', async () => {
  for (const mode of ['foreign', 'duplicate', 'changed', 'empty']) {
    const caseRecord = { checks: [], notes: [] }
    const fixtures = createFixtureCleanup({ caseId: 'MAINT-005', caseRecord })
    const first = Array.from({ length: 100 }, (_, index) => ({ id: String(401 + index), planId: '101' }))
    let deleted = false
    trackGeneratedTaskCleanup(fixtures, {
      getBusiness: async (path) => ({
        code: 0,
        data: {
          list: path.includes('pageNo=1&') ? first : mode === 'empty' ? [] : [{
            id: mode === 'duplicate' ? '401' : '501', planId: mode === 'foreign' ? '102' : '101'
          }],
          total: mode === 'changed' && path.includes('pageNo=2&') ? 102 : 101
        }
      }),
      deleteBusiness: async () => { deleted = true }
    }, '101')
    await assert.rejects(fixtures.cleanup(false), /测试数据清理失败/)
    assert.equal(deleted, false, mode)
  }
})

test('runtime plan cleanup fails closed when its task read fails', async () => {
  const caseRecord = { checks: [], notes: [] }
  const fixtures = createFixtureCleanup({ caseId: 'MAINT-005', caseRecord })
  let deleted = false
  trackInspectionRuntimePlan(fixtures, {
    getBusiness: async () => { throw new Error('simulated read failure') },
    deleteBusiness: async () => { deleted = true }
  }, '101')
  await assert.rejects(fixtures.cleanup(false), /测试数据清理失败/)
  assert.equal(deleted, false)
})

test('missing or malformed pagination totals cannot authorize task or parent deletion', async () => {
  for (const total of [undefined, null, '', false, -1, 0.5, 'invalid', Number.MAX_SAFE_INTEGER + 1]) {
    for (const track of [trackGeneratedTaskCleanup, trackInspectionRuntimePlan]) {
      const fixtures = createFixtureCleanup({
        caseId: 'MAINT-005', caseRecord: { checks: [], notes: [] }
      })
      let deleted = false
      track(fixtures, {
        getBusiness: async () => ({ code: 0, data: { list: [], total } }),
        deleteBusiness: async () => { deleted = true }
      }, '101')
      await assert.rejects(fixtures.cleanup(false), /测试数据清理失败/)
      assert.equal(deleted, false, `${track.name}:${String(total)}`)
    }
  }
})
