import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertCompleteTeamPages,
  assignOwnedTeamRole,
  closeWorkbenchTeamBrowser,
  runWorkbenchTeamClosure
} from '../fixtures/workbench-team-closure.mjs'
import { createOwnedRegistry } from '../workbenchhelper/owned.mjs'
import { ownedCaseConclusion } from '../workbenchhelper/contracts.mjs'
import { summarizeWorkbenchReports } from '../suites/workbench.mjs'

const marker = 'E2E-WBF-012-UNIT'
const today = '2026-10-15'
const success = (data) => ({ code: 0, data })
const IDS = {
  owner: '2110538109578686466', peer: '2110538109578686467',
  observer: '2110538109578686468', project: '2110538109578686469',
  handover: '2110538109578686470', ownerRole: '2110538109578686471',
  ownerReport: '2110538109578686472', peerReport: '2110538109578686473'
}
const recordFor = () => ({ checks: [], notes: [], evidence: [] })
const pageOf = (rows) => ({ list: rows, total: rows.length })
const daily = (owner = IDS.owner, reportId = IDS.ownerReport) => ({
  id: reportId, projectId: IDS.project, reporterId: owner, reportType: 'DAILY',
  periodKey: today, status: 'SUBMITTED'
})
const crm = (type, owner, reportId) => ({
  id: reportId, reportType: type, ownerUserId: owner, status: 'DRAFT',
  periodStart: '2026-10-01', periodEnd: '2026-10-31'
})
const baseContract = () => ({
  projectId: IDS.project, ownerId: IDS.owner, peerId: IDS.peer,
  ownerReportId: IDS.ownerReport, peerReportId: IDS.peerReport,
  crmIds: { WEEKLY: '101', MONTHLY: '102' }
})
const pagesFor = (scope = 'team') => ({
  DAILY: pageOf(scope === 'self' ? [daily()] : [daily(), daily(IDS.peer, IDS.peerReport)]),
  WEEKLY: pageOf([crm('WEEKLY', IDS.owner, '101')]),
  MONTHLY: pageOf([crm('MONTHLY', IDS.owner, '102')])
})

const originalFetch = globalThis.fetch
test.before(() => {
  globalThis.fetch = async () => assert.fail('Network is forbidden in team closure unit tests')
})
test.after(() => { globalThis.fetch = originalFetch })

test('team pages require exactly two authorized daily reports and only owner CRM drafts', () => {
  assertCompleteTeamPages({ ...baseContract(), pages: pagesFor(), scope: 'team' })
  assertCompleteTeamPages({ ...baseContract(), pages: pagesFor('self'), scope: 'self' })
  for (const mutate of [
    (pages) => { pages.DAILY.total = 3 },
    (pages) => { pages.DAILY.list[1].id = '999' },
    (pages) => { pages.DAILY.list[1].projectId = '999' },
    (pages) => { pages.DAILY.list[1].reporterId = IDS.observer },
    (pages) => { pages.DAILY.list[1].id = IDS.ownerReport },
    (pages) => { pages.DAILY.list[1].status = 'DRAFT' },
    (pages) => { pages.WEEKLY.list[0].ownerUserId = IDS.peer },
    (pages) => { pages.MONTHLY.list[0].reportType = 'WEEKLY' },
    (pages) => { pages.MONTHLY.list = []; pages.MONTHLY.total = 0 }
  ]) {
    const pages = pagesFor()
    mutate(pages)
    assert.throws(() => assertCompleteTeamPages({ ...baseContract(), pages, scope: 'team' }))
  }
  assert.throws(() => assertCompleteTeamPages({
    ...baseContract(), pages: pagesFor(), scope: 'self'
  }), /unexpected report IDs/)
})

function harness (options = {}) {
  const events = []
  const caseRecord = recordFor()
  const registry = createOwnedRegistry(marker, caseRecord)
  const permissions = [
    'pm:daily-report:query', 'crm:work-report:query', 'pm:daily-report:update',
    'crm:work-report:create', 'crm:work-report:delete'
  ]
  const menus = [
    { id: 1, parentId: 0, component: 'Home/SystemIndex', status: 0 },
    ...permissions.map((permission, index) => ({ id: index + 2, parentId: 0, status: 0, permission }))
  ]
  const account = (userId, tag, menuIds = menus.map((row) => row.id)) => ({
    userId, username: `unit-${tag}`, roleId: `20${tag === 'owner' ? '1' : tag === 'peer' ? '2' : '3'}`,
    menuIds, state: {}
  })
  const ownerAccount = account(IDS.owner, 'owner')
  const accounts = new Map([[IDS.owner, ownerAccount]])
  const users = new Map([[IDS.owner, { id: IDS.owner, remark: marker, deptId: null }]])
  const roles = new Map([[IDS.ownerRole, {
    id: IDS.ownerRole, projectId: IDS.project, userId: IDS.owner, roleCode: 'REPORTER',
    status: 'ACTIVE', effectiveStart: '2026-10-14'
  }]])
  const reports = new Map([
    [IDS.ownerReport, daily()],
    ['101', crm('WEEKLY', IDS.owner, '101')],
    ['102', crm('MONTHLY', IDS.owner, '102')]
  ])
  const fixture = {
    marker, projectId: IDS.project, handoverId: IDS.handover, roleId: IDS.ownerRole,
    accountId: IDS.owner, ownerId: '1'
  }
  let nextRole = 301
  let nextCrm = 401
  const member = (userId) => [...roles.values()].some((row) =>
    row.userId === userId && row.status === 'ACTIVE' && row.effectiveStart <= today &&
    (row.effectiveEnd == null || row.effectiveEnd >= today))
  const getPage = (userId, pathname) => {
    const url = new URL(pathname, 'http://unit.invalid')
    const isDaily = url.pathname.startsWith('/pm/')
    if (isDaily && url.pathname.endsWith('/get')) {
      return member(userId) ? success(reports.get(url.searchParams.get('id'))) : { code: 403 }
    }
    if (isDaily && url.searchParams.has('projectId') && !member(userId)) {
      return options.denialCode ? { code: options.denialCode } : { code: 403 }
    }
    const type = url.searchParams.get('reportType')
    const ownerFilter = url.searchParams.get(isDaily ? 'reporterId' : 'ownerUserId')
    const rows = [...reports.values()].filter((row) =>
      row.reportType === type && (isDaily ? member(userId) : row.ownerUserId === userId) &&
      (!ownerFilter || String(row[isDaily ? 'reporterId' : 'ownerUserId']) === ownerFilter))
    if (userId === IDS.observer && isDaily &&
      [...roles.values()].some((row) => row.userId === userId &&
        ((options.futureLeak && row.roleCode.startsWith('REPORTER_FUTURE')) ||
          (options.expiredLeak && row.roleCode.startsWith('REPORTER_EXPIRED'))))) rows.push(daily())
    return success(pageOf(rows))
  }
  const adminApi = {
    async get (pathname) {
      events.push(['admin-get', pathname])
      if (pathname === '/system/menu/list') return success(menus)
      if (pathname === '/system/tenant/get?id=1') return success({ id: '1', packageId: '10' })
      if (pathname === '/system/tenant-package/get?id=10') {
        return success({ status: 0, menuIds: menus.map((row) => row.id) })
      }
      if (pathname.startsWith('/system/user/get?id=')) return success(users.get(pathname.split('=')[1]))
      if (pathname.startsWith('/pm/project/get?id=')) {
        return success({ id: IDS.project, customerNameSnapshot: options.corruptMarker ? 'foreign' : marker,
          handoverId: IDS.handover })
      }
      if (pathname.startsWith('/pm/project-role/list?')) return success([...roles.values()])
      assert.fail(`Unmocked admin GET ${pathname}`)
    },
    async putBusiness (pathname, body) {
      events.push(['admin-put', pathname, body])
      if (pathname === '/pm/project-role/assign') {
        assert.equal(typeof body.projectId, 'string')
        assert.equal(typeof body.userId, 'string')
        assert.equal(typeof body.sourceId, 'string')
        for (const row of roles.values()) {
          if (row.roleCode === body.roleCode) row.status = 'ENDED'
        }
        if (options.endOwner) roles.get(IDS.ownerRole).status = 'ENDED'
        const roleId = String(nextRole++)
        roles.set(roleId, { ...body, id: roleId, status: 'ACTIVE' })
        return success(roleId)
      }
      if (pathname.startsWith('/pm/project-role/end?id=')) {
        roles.get(pathname.split('=')[1]).status = 'ENDED'
        return success(true)
      }
      assert.fail(`Unmocked admin PUT ${pathname}`)
    }
  }
  adminApi.getBusiness = adminApi.get
  const ownApi = (userId) => {
    const api = {
      async get (pathname) {
        events.push(['owned-get', userId, pathname])
        if (pathname.startsWith('/crm/work-report/get?id=')) {
          return success(reports.get(pathname.split('=')[1]))
        }
        return getPage(userId, pathname)
      },
      async post (pathname, body) {
        assert.equal(pathname, '/crm/work-report/create')
        const reportId = String(nextCrm++)
        reports.set(reportId, { ...body, id: reportId, status: 'DRAFT', ownerUserId: userId })
        return success(reportId)
      },
      async delete (pathname) {
        assert.match(pathname, /^\/crm\/work-report\/delete\?id=/)
        reports.delete(pathname.split('=')[1])
        return success(true)
      }
    }
    api.getBusiness = api.get
    return api
  }
  const makeHandle = (user) => {
    const state = { period: 'month', scope: 'self', visible: false, pages: pagesFor('self') }
    const locator = (selector) => ({
      first () { return this },
      locator (nested) { return locator(nested) },
      filter ({ hasText }) {
        return { click: async () => {
          const periods = { 本月: 'month', 本季度: 'quarter', 本年度: 'year' }
          if (periods[hasText]) state.period = periods[hasText]
          else state.scope = hasText === '本人' ? 'self' : 'team'
          events.push(['radio', user.userId, hasText])
        } }
      },
      getByRole (_role, { name }) {
        return { click: async () => {
          if (name === '统计') state.visible = true
          else if (name === '关闭') state.visible = false
          else assert.fail(`Unexpected button ${name}`)
          events.push(['button', user.userId, name])
        } }
      },
      waitFor: async () => {},
      isVisible: async () => selector === '.report-stats-dialog' ? state.visible : true
    })
    const page = {
      userId: user.userId, state, locator,
      url: () => 'http://127.0.0.1:9151/index',
      async evaluate (fn) {
        if (fn.name !== 'statsSnapshot') return today
        return {
          visible: state.visible,
          rows: options.badDom && user.userId === IDS.owner
            ? [['日报', '999', '0', '0', '0']]
            : summarizeWorkbenchReports(state.pages, state.period, today),
          selected: [
            { month: '本月', quarter: '本季度', year: '本年度' }[state.period],
            state.scope === 'self' ? '本人' : '团队（按数据权限）'
          ]
        }
      },
      waitForTimeout: async () => {}
    }
    return {
      page, api: ownApi(user.userId),
      permission: { user: { id: user.userId },
        roles: [options.adminPeer && user.userId === IDS.peer ? 'crm_admin' : `unit-${user.userId}`],
        permissions: user.menuIds.filter((id) => String(id) !== '1')
          .map((id) => menus.find((row) => String(row.id) === String(id)).permission) },
      flushResponses: async () => events.push(['flush', user.userId]),
      context: {
        tracing: { stop: async ({ path }) => events.push(['trace', user.userId, path]) },
        close: async () => events.push(['context-close', user.userId])
      },
      browser: { close: async () => events.push(['browser-close', user.userId]) }
    }
  }
  const ownerHandle = makeHandle(ownerAccount)
  const tools = {
    statsTimeoutMs: 1,
    async createOwnedAccount ({ tag, menuIds }) {
      const user = account(tag === 'peer' ? IDS.peer : IDS.observer, tag, menuIds)
      accounts.set(user.userId, user)
      users.set(user.userId, { id: user.userId, remark: marker, deptId: options.peerDepartment && tag === 'peer' ? '88' : null })
      events.push(['create-account', tag, menuIds])
      return user
    },
    async newOwnedBrowser ({ account }) { return makeHandle(account) },
    async createWorkbenchDailyReport ({ account, fixture, periodKey }) {
      assert.equal(fixture.projectId, IDS.project)
      assert.equal(periodKey, today)
      assert.ok(member(account.userId))
      const row = daily(account.userId, IDS.peerReport)
      reports.set(row.id, row)
      return { draftId: row.id, periodKey, submitted: row }
    },
    async captureOwnedWorkbenchReports (page, action, userId, scope) {
      await action()
      assert.equal(userId, page.userId)
      const pages = {}
      for (const type of ['DAILY', 'WEEKLY', 'MONTHLY']) {
        const ownerKey = type === 'DAILY' ? 'reporterId' : 'ownerUserId'
        const query = `/${type === 'DAILY' ? 'pm/daily-report' : 'crm/work-report'}/page?pageNo=1&pageSize=100&reportType=${type}` +
          (scope === 'self' ? `&${ownerKey}=${userId}` : '')
        const body = await ownApi(userId).get(query)
        assert.equal(body.code, 0)
        pages[type] = body.data
      }
      if (options.missing && userId === IDS.owner) return { pages, missing: ['Missing monthly GET'] }
      page.state.pages = pages
      events.push(['capture', userId, page.state.period, scope])
      return { pages, missing: [] }
    },
    openRoute: async () => {},
    waitForReportRendering: async () => {},
    saveScreenshot: async (_page, _outputDir, name) => events.push(['screenshot', name])
  }
  const args = {
    adminApi, ownerAccount, ownerHandle, fixture,
    report: { draftId: IDS.ownerReport, periodKey: today, submitted: daily() },
    crmReportIds: ['101', '102'], registry, marker, caseRecord, record: {},
    outputDir: '/tmp/cfor-e2e/unit-team-closure', tools
  }
  return { args, events, roles, accounts, caseRecord, registry }
}

test('full closure maps all five assertions, clicks team and back, and cleans only owned role IDs', async () => {
  const f = harness()
  const evidence = await runWorkbenchTeamClosure(f.args)
  assert.deepEqual(evidence.steps.map(({ period, scope }) => `${period}/${scope}`),
    ['month/self', 'quarter/self', 'year/self', 'year/team', 'year/self'])
  assert.deepEqual(evidence.steps.map((step) => step.expected[0][1]), ['1', '1', '1', '2', '1'])
  assert.deepEqual(evidence.observerPhases, ['nonmember', 'future', 'expired'])
  assert.equal(f.caseRecord.catalogAssertions.length, 5)
  assert.ok(f.caseRecord.catalogAssertions.every((row) => row.status === 'VERIFIED'))
  assert.equal(ownedCaseConclusion('WBF-012', f.caseRecord).catalogComplete, true)
  assert.ok(f.events.filter(([kind]) => kind === 'create-account').every(([, tag, menuIds]) =>
    tag !== 'observer' || menuIds.every((menuId) => ['1', '2', '3'].includes(String(menuId)))))
  assert.equal(f.roles.get(IDS.ownerRole).status, 'ACTIVE')
  const assigned = [...f.roles.values()].filter((row) => row.id !== IDS.ownerRole)
  assert.equal(assigned.length, 3)
  assert.ok(assigned.every((row) => row.roleCode.includes(marker) && row.roleCode !== 'REPORTER'))
  for (const step of evidence.steps) {
    assert.equal(step.requests.length, 3)
    assert.ok(step.requests.every((query) => query.includes('pageSize=100')))
    assert.equal(step.reports.WEEKLY[0].ownerId, IDS.owner)
    assert.equal(step.reports.MONTHLY[0].ownerId, IDS.owner)
  }
  await f.registry.cleanup()
  assert.equal(f.roles.get(IDS.ownerRole).status, 'ACTIVE')
  assert.ok(assigned.every((row) => row.status === 'ENDED'))
  const ended = f.events.filter(([kind, pathname]) => kind === 'admin-put' && pathname.includes('/end?'))
  assert.deepEqual(ended.map(([, pathname]) => pathname.split('=')[1]).sort(),
    assigned.map((row) => row.id).sort())
  assert.deepEqual(f.events.filter(([kind]) => kind === 'browser-close').map(([, userId]) => userId),
    [IDS.observer, IDS.peer])
})

test('future membership leakage fails the closure without treating empty self pages as team isolation', async () => {
  const f = harness({ futureLeak: true })
  await assert.rejects(runWorkbenchTeamClosure(f.args), /unauthorized report page is not empty/)
  assert.deepEqual(f.caseRecord.workbenchTeamClosure.observerPhases, ['nonmember'])
  assert.equal(f.caseRecord.catalogAssertions[3].status, 'UNVERIFIED')
  assert.ok(f.caseRecord.checks.some((row) => row.passed === false))
  await f.registry.cleanup()
})

test('expired membership leakage fails even after the future-member counterexample passed', async () => {
  const f = harness({ expiredLeak: true })
  await assert.rejects(runWorkbenchTeamClosure(f.args), /unauthorized report page is not empty/)
  assert.deepEqual(f.caseRecord.workbenchTeamClosure.observerPhases, ['nonmember', 'future'])
  assert.equal(f.caseRecord.catalogAssertions[3].status, 'UNVERIFIED')
  await f.registry.cleanup()
})

test('server failures are never accepted as membership denials', async () => {
  const f = harness({ denialCode: 500 })
  await assert.rejects(runWorkbenchTeamClosure(f.args), /不能读取专属项目分页/)
  assert.equal(f.caseRecord.catalogAssertions[3].status, 'UNVERIFIED')
  assert.equal(f.events.filter(([kind]) => kind === 'browser-close').length, 2)
  await f.registry.cleanup()
})

test('a missing browser GET or incorrect visible statistic cannot verify the catalog', async () => {
  for (const options of [{ missing: true }, { badDom: true }]) {
    const f = harness(options)
    await assert.rejects(runWorkbenchTeamClosure(f.args), /Missing one|statistics mismatch/)
    assert.equal(f.caseRecord.catalogAssertions[0].status, 'UNVERIFIED')
    assert.equal(ownedCaseConclusion('WBF-012', f.caseRecord).catalogComplete, false)
    assert.ok(f.events.some(([kind, userId]) => kind === 'browser-close' && userId === IDS.peer))
    await f.registry.cleanup()
  }
})

test('broad CRM roles, a department relationship, or ending the owner role cannot produce team evidence', async () => {
  for (const options of [{ adminPeer: true }, { peerDepartment: true }, { endOwner: true }]) {
    const f = harness(options)
    await assert.rejects(runWorkbenchTeamClosure(f.args), /受限用户|部门下属|两人均为/)
    assert.equal(f.caseRecord.catalogAssertions[3].status, 'UNVERIFIED')
    assert.equal(f.caseRecord.workbenchTeamClosure.steps.length, 0)
    await f.registry.cleanup()
  }
})

test('role cleanup checks the marker and exact returned role ID before ending a role', async () => {
  const f = harness({ corruptMarker: true })
  await assert.rejects(assignOwnedTeamRole({
    adminApi: f.args.adminApi, registry: f.registry, fixture: f.args.fixture,
    accountId: IDS.peer, roleKind: 'REPORTER_PEER', marker, today
  }), /Owned project role readback failed/)
  const failures = await f.registry.cleanup()
  assert.equal(failures.length, 1)
  assert.ok(!f.events.some(([kind, pathname]) => kind === 'admin-put' && pathname.includes('/end?')))
})

test('role helper refuses the colliding REPORTER role before writing', async () => {
  const f = harness()
  await assert.rejects(assignOwnedTeamRole({
    adminApi: f.args.adminApi, registry: f.registry, fixture: f.args.fixture,
    accountId: IDS.peer, roleKind: 'REPORTER', marker, today
  }))
  assert.ok(!f.events.some(([kind]) => kind === 'admin-put'))
})

test('role marker mismatch is rejected before assigning any project role', async () => {
  const f = harness()
  await assert.rejects(assignOwnedTeamRole({
    adminApi: f.args.adminApi, registry: f.registry, fixture: f.args.fixture,
    accountId: IDS.peer, roleKind: 'REPORTER_PEER', marker: `${marker}-OTHER`, today
  }))
  assert.ok(!f.events.some(([kind]) => kind === 'admin-put'))
})

test('browser closure preserves cleanup even if trace flushing fails', async () => {
  const events = []
  const caseRecord = recordFor()
  await closeWorkbenchTeamBrowser({
    flushResponses: async () => { throw new Error('flush failed') },
    context: { close: async () => events.push('context') },
    browser: { close: async () => events.push('browser') }
  }, '/tmp/cfor-e2e/unit-team-closure', 'unit', caseRecord)
  assert.deepEqual(events, ['context', 'browser'])
  assert.equal(caseRecord.checks[0].passed, false)
})

test('browser closure still closes the browser when context shutdown fails', async () => {
  const caseRecord = recordFor()
  let closed = false
  await closeWorkbenchTeamBrowser({
    context: {
      tracing: { stop: async () => {} },
      close: async () => { throw new Error('context close failed') }
    },
    browser: { close: async () => { closed = true } }
  }, '/tmp/cfor-e2e/unit-team-closure', 'unit', caseRecord)
  assert.equal(closed, true)
  assert.equal(caseRecord.checks[0].passed, false)
})
