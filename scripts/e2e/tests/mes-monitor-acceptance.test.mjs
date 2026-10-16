import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  runCase, catalogAssertions, monitorAlarmFields, monitorDispatchEvidence
} from '../suites/mes-monitor.mjs'

const ok = (data) => ({ code: 0, data })
const settings = {
  target: 'local', tenantId: '1', tenantName: 'CFOR 标准平台',
  webBase: 'http://127.0.0.1:9151', apiBase: 'http://127.0.0.1:48083',
  db: { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard' }
}

function harness (options = {}) {
  const calls = []
  const caseRecord = { checks: [], notes: [], evidence: [] }
  const resources = []
  let nextId = 1000, menus = [], actorId, role, user, ledgerRows = [], dispatchCount = 0
  let workStatus = 1, initialPlaceRead = true
  const marker = 'AUTOTEST-MONITOR-UNIT'
  const find = (id) => resources.find((row) => row.id === String(id) && !row.deleted)
  const workplaceRows = () => resources.filter((row) => row.kind === 'workplace' && !row.deleted)
    .map((row) => ({ id: row.id, code: row.code, name: row.name, description: row.remark }))
  const call = async (method, path, body, actor = false) => {
    calls.push({ method, path, body: structuredClone(body), actor })
    const url = new URL(path, 'http://unit')
    const endpoint = url.pathname
    const id = url.searchParams.get('id')
    if (method === 'POST' && [
      '/system/dept/create', '/mes/mesWorkPlace/add', '/mes/mesWorkLine/add',
      '/system/role/create', '/system/user/create'
    ].includes(endpoint)) {
      const kind = endpoint.includes('/dept/') ? 'dept' : endpoint.includes('WorkPlace') ? 'workplace'
        : endpoint.includes('WorkLine') ? 'line' : endpoint.includes('/role/') ? 'role' : 'user'
      const row = { ...body, id: String(++nextId), kind, type: 2, deleted: 0, status: body.status ?? 0 }
      resources.push(row)
      if (kind === 'role') role = row
      if (kind === 'user') { user = row; actorId = row.id }
      return ok(['line', 'workplace'].includes(kind) ? '添加成功！' : row.id)
    }
    if (method === 'POST' && endpoint === '/system/permission/assign-role-menu') { menus = body.menuIds; return ok(true) }
    if (method === 'POST' && endpoint === '/system/permission/assign-role-data-scope') { role.dataScope = body.dataScope; return ok(true) }
    if (method === 'GET' && endpoint === '/system/menu/list') {
      return ok([{ id: '50', parentId: 0, status: 0, permission: '',
        component: options.homeOnly ? 'Home/SystemIndex' : 'mes/monitor/index' }])
    }
    if (method === 'GET' && endpoint === '/system/permission/list-role-menus') return ok(menus)
    if (method === 'GET' && endpoint === '/system/permission/list-user-roles') return ok([role.id])
    if (method === 'GET' && endpoint === '/system/user/profile/get') {
      return ok({ id: actorId, dept: { id: user.deptId } })
    }
    if (method === 'GET' && endpoint === '/mes/monitor/workplaces') {
      const rows = workplaceRows()
      return ok(actor && !options.leakOutside ? rows.filter((row) => !row.code.endsWith('-OUT')) : rows)
    }
    if (method === 'GET' && endpoint === '/mes/monitor/production-dashboard') {
      const place = find(url.searchParams.get('workplaceId'))
      if (actor && place.code.endsWith('-OUT')) {
        return options.wrongRejection || { code: 403, msg: '无权查看该车间的生产看板' }
      }
      return ok({
        workplace: { id: place.id },
        lines: [{ lineId: resources.find((row) => row.kind === 'line').id }],
        alarms: options.foreignAlarm
          ? [{ sourceType: 'WORK', sourceId: '99999', alarmKey: 'WORK_OVERDUE:99999' }]
          : [{ sourceType: 'WORK', sourceId: '9000', alarmKey: 'WORK_OVERDUE:9000' }],
        trends: []
      })
    }
    if (method === 'GET' && endpoint === '/mes/prodWork/queryById') {
      return ok({ id: '9000', status: workStatus, remark: marker, prodOrderId: '9002' })
    }
    if (method === 'GET' && endpoint === '/mes/prodOrder/queryById') return ok({ id: '9002', status: 1 })
    if (method === 'GET' && endpoint === '/mes/prodWorkTask/queryById') return ok({ id: '9001', status: 0, reportVersion: 0 })
    if (method === 'POST' && endpoint === '/mes/monitor/alarms/dispatch') {
      assert.equal(find(url.searchParams.get('workplaceId')).code.endsWith('-CHILD'), true)
      dispatchCount += 1
      if (options.dispatchFailure) throw new Error('unit dispatch transport failure')
      const alarmKey = 'WORK_OVERDUE:9000'
      if (dispatchCount === 1) {
        ledgerRows = [['5000', alarmKey, actorId, '6000', '6000', actorId, 'mes_monitor_alarm', alarmKey]]
        if (options.missingNotification) ledgerRows[0][4] = 'NULL'
        if (options.wrongReceiver) ledgerRows[0][5] = '9999'
        if (options.mutateProduction) workStatus = 2
      }
      return ok({
        scannedCount: 1, dispatchedCount: dispatchCount === 1 ? 1 : 0, skippedCount: dispatchCount === 1 ? 0 : 1,
        items: [{ alarmKey, dispatched: dispatchCount === 1, message: '已生成待办与站内通知' }]
      })
    }
    if (method === 'GET' && /\/(?:get|queryById)$/.test(endpoint)) {
      const row = find(id)
      if (row?.kind === 'workplace' && initialPlaceRead) {
        initialPlaceRead = false
        const audit = caseRecord.fixtureResiduals.find((item) => item.kind === row.kind && item.code === row.code)
        assert.equal(audit.id, row.id)
        if (options.placeReadFailure) throw new Error('unit workplace readback failed')
      }
      return ok(row || null)
    }
    if (method === 'PUT') {
      const row = find(body.id)
      assert.ok(row)
      Object.assign(row, body)
      return ok(true)
    }
    if (method === 'DELETE') {
      const row = find(id)
      assert.ok(row)
      row.deleted = 1
      return ok(true)
    }
    throw new Error(`Unexpected monitor call: ${method} ${path}`)
  }
  const apiFor = (actor) => ({
    getBusiness: (path) => call('GET', path, undefined, actor),
    postBusiness: (path, body) => call('POST', path, body, actor),
    putBusiness: (path, body) => call('PUT', path, body, actor),
    deleteBusiness: (path) => call('DELETE', path, undefined, actor),
    request: (method, path, body, requestOptions) => {
      assert.equal(requestOptions.expectedBusinessRejection.code, 403)
      return call(method, path, body, actor)
    }
  })
  class Fixture {
    constructor (api, _record, _caseId, fixtureOptions) {
      this.api = api
      this.marker = marker
      assert.equal(fixtureOptions.overdue, true)
      assert.equal(fixtureOptions.withOpeningInventory, true)
    }

    async setup () {
      const places = (await this.api.getBusiness('/mes/monitor/workplaces')).data
      assert.equal(places.length, 1)
      this.workplace = places[0]
      this.lineId = resources.find((row) => row.kind === 'line').id
      this.works = [{ id: '9000' }]
      this.tasks = [{ id: '9001' }]
      this.order = { id: '9002' }
      calls.push({ method: 'FIXTURE_SETUP' })
    }

    async cleanup () { calls.push({ method: 'FIXTURE_CLEANUP' }) }
  }
  return {
    calls, caseRecord, resources,
    run: () => runCase({
      page: { admin: true }, record: { api: [], screenshots: [] }, caseRecord, outputDir: '/unused'
    }, {
      settings, env: { CFOR_E2E_WRITE_FIXTURES: 'true' },
      login: async () => 'admin-token', writeSafety: async () => {},
      createApiClient: ({ token }) => apiFor(token === 'actor-token'),
      ExecutionWorkflowFixture: Fixture,
      headedActor: async () => {
        calls.push({ method: 'HEADED_LOGIN' })
        return { token: 'actor-token', page: {}, close: async () => calls.push({ method: 'ACTOR_CLOSE' }) }
      },
      sql: async (sql) => {
        if (sql.includes('mes_monitor_alarm_dispatch')) return { available: true, rows: structuredClone(ledgerRows) }
        const code = /code='([^']+)'/.exec(sql)?.[1]
        const kind = sql.includes('mes_work_place') ? 'workplace' : sql.includes('mes_work_line') ? 'line' : 'dept'
        if (code) return { available: true, rows: resources.filter((row) =>
          row.kind === kind && row.code === code && !row.deleted).map((row) => [row.id]) }
        const id = /AND id=(\d+)/.exec(sql)?.[1]
        assert.ok(id, sql)
        return { available: true, rows: [[find(id) ? '1' : '0']] }
      },
      openRoute: async (_page, route, routeOptions) => {
        assert.equal(route, '/mes/monitor')
        assert.deepEqual(routeOptions, {
          readySelector: '.ioc-shell .command-strip',
          readyTimeoutMs: 20000
        })
        calls.push({ method: 'ROUTE' })
        if (options.routeFailure) throw new Error('unit route failure')
      },
      verifyMonitorPage: async (page, details, dependencies) => {
        await dependencies.openRoute(page, '/mes/monitor', {
          readySelector: '.ioc-shell .command-strip',
          readyTimeoutMs: 20000
        })
        calls.push({ method: 'MONITOR_PAGE', details })
        return {
          route: '/mes/monitor',
          workplaceId: details.workplace.id,
          lineId: details.lineId,
          alarmKey: details.alarmKey,
          status: 'VERIFIED'
        }
      },
      saveScreenshot: async () => {}
    })
  }
}

test('monitor mappings preserve exact unchanged original assertion text', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url)))
  assert.deepEqual(catalogAssertions, catalog.suites.flatMap((suite) => suite.cases)
    .find((item) => item.id === 'MES-MONITOR-001').assertions)
})

test('alarm fields require nonempty unique exact source keys and valid source IDs', () => {
  const good = { alarmKey: 'WORK_OVERDUE:9000', sourceType: 'WORK', sourceId: '9000' }
  assert.equal(monitorAlarmFields([good]), true)
  assert.equal(monitorAlarmFields([{ alarmKey: 'DEVICE_ALARM:10', sourceType: 'DEVICE', sourceId: '10' }]), true)
  for (const rows of [[], [good, good], [{ ...good, sourceId: '' }],
    [{ ...good, sourceType: 'OTHER' }], [{ ...good, alarmKey: 'WORK_OVERDUE:9' }]]) {
    assert.equal(monitorAlarmFields(rows), false)
  }
})

test('dispatch success text alone cannot prove real linked same-receiver notification', () => {
  const row = ['1', 'WORK_OVERDUE:9', '2', '3', '3', '2', 'mes_monitor_alarm', 'WORK_OVERDUE:9']
  assert.equal(monitorDispatchEvidence({ available: true, rows: [row] }, row[1], '2'), true)
  for (const [index, value] of [[3, 'NULL'], [4, '4'], [5, '5'], [6, 'other'], [7, 'WORK_OVERDUE:8']]) {
    const changed = [...row]
    changed[index] = value
    assert.equal(monitorDispatchEvidence({ available: true, rows: [changed] }, row[1], '2'), false)
  }
  assert.equal(monitorDispatchEvidence({ available: false, rows: [row] }, row[1], '2'), false)
})

test('monitor runs owned department counterexample, scoped execution, ledger, notification and stable state checks', async () => {
  const h = harness()
  assert.equal((await h.run()).partial, false)
  assert.deepEqual(h.caseRecord.catalogAssertions.map((row) => [row.index, row.status]), [
    [0, 'VERIFIED'], [1, 'VERIFIED'], [2, 'VERIFIED'], [3, 'VERIFIED']
  ])
  const dispatches = h.calls.filter((call) => call.path?.includes('/alarms/dispatch'))
  assert.equal(dispatches.length, 2)
  assert.ok(dispatches.every((call) => call.actor))
  assert.ok(h.calls.findIndex((call) => call.method === 'ACTOR_CLOSE') <
    h.calls.findIndex((call) => call.method === 'FIXTURE_CLEANUP'))
  assert.ok(h.caseRecord.checks.every((check) => check.passed), JSON.stringify(h.caseRecord.checks))
  const retained = h.caseRecord.fixtureResiduals.filter((row) => row.cleanup === 'RETAINED_AUDIT_DISABLED')
  assert.deepEqual(retained.map((row) => row.kind).sort(), ['dept', 'role', 'user'])
  assert.ok(h.resources.filter((row) => row.kind === 'workplace' || row.kind === 'line').every((row) => row.deleted === 1))
  const audit = h.caseRecord.fixtureResiduals.find((row) => row.kind === 'monitor-dispatch')
  assert.deepEqual(audit.dispatchIds, ['5000'])
  assert.deepEqual(audit.notificationIds, ['6000'])
  assert.ok(h.resources.filter((row) => ['role', 'user'].includes(row.kind)).every((row) => row.status === 1 && row.deleted === 0))
})

test('monitor missing messages, wrong recipients or mutated production cannot verify dispatch original', async () => {
  for (const options of [{ missingNotification: true }, { wrongReceiver: true }, { mutateProduction: true }]) {
    const h = harness(options)
    assert.equal((await h.run()).partial, true)
    assert.equal(h.caseRecord.catalogAssertions[3].status, 'FAILED')
    assert.deepEqual(h.caseRecord.remainingAssertions, [catalogAssertions[3]])
  }
})

test('monitor leaked outside department and unrelated denial cannot verify filtering original', async () => {
  for (const options of [{ leakOutside: true }, { wrongRejection: { code: 500, msg: '系统错误' } }]) {
    const h = harness(options)
    await h.run()
    assert.equal(h.caseRecord.catalogAssertions[0].status, 'FAILED')
  }
})

test('monitor never dispatches foreign alarms and still cleans its created topology and actors', async () => {
  const h = harness({ foreignAlarm: true })
  await assert.rejects(h.run, /dispatch may only address/)
  assert.equal(h.calls.some((call) => call.path?.includes('/alarms/dispatch')), false)
  assert.equal(h.caseRecord.catalogAssertions[2].status, 'FAILED')
  assert.ok(h.caseRecord.fixtureResiduals.every((row) => row.cleanup === 'DELETED_VERIFIED'))
})

test('monitor workplace readback failure retains ID/code audit and invokes cleanup before any production setup', async () => {
  const h = harness({ placeReadFailure: true })
  await assert.rejects(h.run, /readback failed/)
  const place = h.caseRecord.fixtureResiduals.find((row) => row.kind === 'workplace')
  assert.ok(place.id)
  assert.equal(place.cleanup, 'DELETED_VERIFIED')
  assert.equal(h.calls.some((call) => call.method === 'FIXTURE_SETUP'), false)
})

test('ambiguous dispatch failure preserves recipient attribution and structured gaps through finally', async () => {
  const h = harness({ dispatchFailure: true })
  await assert.rejects(h.run, /dispatch transport failure/)
  assert.equal(h.caseRecord.catalogAssertions[3].status, 'GAP')
  assert.ok(h.caseRecord.fixtureResiduals.some((row) => row.kind === 'user' && row.cleanup === 'RETAINED_AUDIT_DISABLED'))
  assert.ok(h.calls.some((call) => call.method === 'FIXTURE_CLEANUP'))
})

test('monitor route failures propagate instead of swallowing headed evidence failures', async () => {
  const h = harness({ routeFailure: true })
  await assert.rejects(h.run, /route failure/)
  assert.ok(h.calls.some((call) => call.method === 'FIXTURE_CLEANUP'))
})

test('static monitor route remains verifiable when the tenant menu is absent', async () => {
  const h = harness({ homeOnly: true })
  assert.equal((await h.run()).partial, false)
  assert.ok(h.caseRecord.catalogAssertions.every((row) => row.status === 'VERIFIED'))
  assert.deepEqual(h.caseRecord.remainingAssertions, [])
  assert.equal(h.caseRecord.uiEvidence.status, 'VERIFIED')
  assert.equal(h.caseRecord.uiEvidence.route, '/mes/monitor')
  assert.equal(h.calls.some((call) => call.method === 'MONITOR_PAGE'), true)
})
