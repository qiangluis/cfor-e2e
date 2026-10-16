import assert from 'node:assert/strict'
import path from 'node:path'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { openRoute, saveScreenshot } from '../lib/browser.mjs'
import { normalizeLocalDate } from '../lib/local-date.mjs'
import {
  collectOwnedNavigationQueryPermissions,
  captureOwnedWorkbenchReports,
  createDrafts,
  createOwnedAccount,
  expectPermissionDenied,
  newOwnedBrowser,
  normalizeOwnedPermissions,
  selectOwnedMenuIds
} from '../workbenchhelper/owned.mjs'
import { recordCatalogAssertion } from '../workbenchhelper/contracts.mjs'
import { createWorkbenchDailyReport } from './workbench-daily-gaps.mjs'
import { summarizeWorkbenchReports, waitForReportRendering } from '../suites/workbench.mjs'

const CASE_ID = 'WBF-012'
const TYPES = ['DAILY', 'WEEKLY', 'MONTHLY']
const READ_PERMISSIONS = ['pm:daily-report:query', 'crm:work-report:query']
const PEER_PERMISSIONS = [
  ...READ_PERMISSIONS, 'pm:daily-report:update',
  'crm:work-report:create', 'crm:work-report:delete'
]
const data = (body) => assertBusinessSuccess(body, CASE_ID).data
const id = (value) => {
  assert.match(String(value), /^[1-9]\d*$/, 'Missing owned ID')
  assert.ok(typeof value !== 'number' || Number.isSafeInteger(value), 'Unsafe numeric ID')
  return String(value)
}
const sortedIds = (values) => values.map(id).sort()
const check = (caseRecord, name, passed, details) => {
  caseRecord.checks.push({ name, passed: Boolean(passed), details })
  assert.ok(passed, `${name}: ${details}`)
}
const reportQuery = (type, owner) => {
  const params = new URLSearchParams({ pageNo: '1', pageSize: '100', reportType: type })
  if (owner !== undefined) params.set(type === 'DAILY' ? 'reporterId' : 'ownerUserId', id(owner))
  return `${type === 'DAILY' ? '/pm/daily-report' : '/crm/work-report'}/page?${params}`
}
const shiftDate = (today, days) => {
  const date = new Date(`${today}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
const roleIsEffective = (row, today) => row.status === 'ACTIVE' &&
  normalizeLocalDate(row.effectiveStart) <= today &&
  (row.effectiveEnd == null || normalizeLocalDate(row.effectiveEnd) >= today)

export function assertCompleteTeamPages ({
  pages, scope, projectId, ownerId, peerId, ownerReportId, peerReportId, crmIds
}) {
  assert.ok(['self', 'team'].includes(scope))
  const dailyIds = scope === 'self' ? [ownerReportId] : [ownerReportId, peerReportId]
  for (const type of TYPES) {
    const page = pages?.[type]
    assert.ok(Array.isArray(page?.list) && Number.isSafeInteger(page.total) &&
      page.total === page.list.length && page.list.length <= 100,
    `${type}: incomplete or invalid report page`)
    const expected = type === 'DAILY' ? dailyIds : [crmIds[type]]
    assert.deepEqual(sortedIds(page.list.map((row) => row.id)), sortedIds(expected),
      `${type}: unexpected report IDs`)
    for (const row of page.list) {
      assert.equal(row.reportType, type)
      if (type === 'DAILY') {
        assert.equal(id(row.projectId), id(projectId), 'Foreign PM project')
        const expectedOwner = id(row.id) === id(ownerReportId) ? ownerId : peerId
        assert.equal(id(row.reporterId), id(expectedOwner), 'Wrong daily reporter')
        assert.equal(row.status, 'SUBMITTED', 'Fixture daily report changed status')
      } else {
        assert.equal(id(row.ownerUserId), id(ownerId), 'Non-subordinate CRM report leaked')
        assert.equal(row.status, 'DRAFT', 'Fixture CRM draft changed status')
      }
    }
  }
  return pages
}

const assertEmptyPage = (body, label) => {
  const page = data(body)
  assert.ok(Array.isArray(page?.list) && page.total === 0 && page.list.length === 0,
    `${label}: unauthorized report page is not empty`)
}

async function readCrmIds (api, reportIds, ownerId) {
  assert.equal(reportIds.length, 2, 'Expected two owned CRM drafts')
  const result = {}
  for (const reportId of reportIds) {
    const row = data(await api.getBusiness(`/crm/work-report/get?id=${id(reportId)}`))
    assert.equal(id(row.id), id(reportId))
    assert.equal(id(row.ownerUserId), id(ownerId))
    assert.ok(['WEEKLY', 'MONTHLY'].includes(row.reportType) && !result[row.reportType])
    assert.equal(row.status, 'DRAFT')
    result[row.reportType] = id(row.id)
  }
  return result
}

async function restrictedMenus (adminApi) {
  const menus = data(await adminApi.get('/system/menu/list'))
  const tenant = data(await adminApi.get('/system/tenant/get?id=1'))
  assert.equal(id(tenant.id), '1')
  const pkg = data(await adminApi.get(`/system/tenant-package/get?id=${id(tenant.packageId)}`))
  assert.ok(pkg?.status === 0 && Array.isArray(pkg.menuIds))
  const select = (permissions) => {
    const menuIds = selectOwnedMenuIds(menus, pkg.menuIds.map((id) => ({ id })), permissions)
    return {
      menuIds,
      permissions: [...permissions,
        ...collectOwnedNavigationQueryPermissions(menus, menuIds, permissions)]
    }
  }
  return { peer: select(PEER_PERMISSIONS), observer: select(READ_PERMISSIONS) }
}

async function verifyActor (adminApi, account, handle, permissions, marker, caseRecord) {
  const actual = normalizeOwnedPermissions(handle.permission?.permissions)
  const roles = handle.permission?.roles
  check(caseRecord, '统计账号为租户1专属受限用户且无全范围管理角色',
    id(handle.permission?.user?.id) === id(account.userId) &&
    Array.isArray(roles) && roles.length > 0 &&
    !roles.some((role) => ['super_admin', 'tenant_admin', 'crm_admin'].includes(role)) &&
    actual.every((permission) => permissions.includes(permission)) &&
    permissions.every((permission) => actual.includes(permission)),
    `userId=${account.userId}; roleId=${account.roleId}; permissions=${actual.join(',')}`)
  const user = data(await adminApi.get(`/system/user/get?id=${id(account.userId)}`))
  check(caseRecord, '专属统计账号未挂接部门下属关系',
    id(user.id) === id(account.userId) && user.remark === marker && user.deptId == null,
    `userId=${account.userId}; deptId=${user.deptId ?? 'null'}`)
}

// Role codes are independent: assigning REPORTER again would end the owner's role.
export async function assignOwnedTeamRole ({
  adminApi, registry, fixture, accountId, roleKind, marker, today,
  effectiveStart = today, effectiveEnd
}) {
  assert.ok(['REPORTER_PEER', 'REPORTER_FUTURE', 'REPORTER_EXPIRED'].includes(roleKind))
  assert.equal(fixture.marker, marker)
  const roleCode = `${roleKind}_${marker}`
  assert.ok(roleCode.length <= 64)
  const roleId = id(data(await adminApi.putBusiness('/pm/project-role/assign', {
    projectId: id(fixture.projectId), userId: id(accountId), roleCode,
    effectiveStart, ...(effectiveEnd ? { effectiveEnd } : {}),
    sourceType: 'MANUAL', sourceId: id(fixture.handoverId)
  })))
  const read = async () => {
    const project = data(await adminApi.getBusiness(`/pm/project/get?id=${id(fixture.projectId)}`))
    const roles = data(await adminApi.getBusiness(`/pm/project-role/list?projectId=${id(fixture.projectId)}`))
    assert.ok(Array.isArray(roles))
    const row = roles.find((item) => id(item.id) === roleId)
    return row && { ...row, ownedMarker: project.customerNameSnapshot,
      ownedHandoverId: project.handoverId }
  }
  const matches = (row) => id(row.id) === roleId &&
    id(row.projectId) === id(fixture.projectId) && id(row.userId) === id(accountId) &&
    row.roleCode === roleCode && row.sourceType === 'MANUAL' &&
    id(row.sourceId) === id(fixture.handoverId) && row.ownedMarker === marker &&
    id(row.ownedHandoverId) === id(fixture.handoverId)
  registry.add({
    type: 'pm-project-role', id: roleId, read,
    matches: (row) => matches(row) && row.status === 'ACTIVE',
    remove: async () => {
      await adminApi.putBusiness(`/pm/project-role/end?id=${roleId}`, undefined)
    },
    verifyRemoved: async () => {
      const row = await read()
      return row && matches(row) && row.status === 'ENDED'
    }
  })
  const row = await read()
  assert.ok(row && matches(row) && row.status === 'ACTIVE', 'Owned project role readback failed')
  assert.equal(normalizeLocalDate(row.effectiveStart), effectiveStart)
  assert.equal(row.effectiveEnd == null ? null : normalizeLocalDate(row.effectiveEnd), effectiveEnd ?? null)
  return { roleId, roleCode, row }
}

export async function verifyTeamObserver ({
  observerApi, ownerApi, peerApi, fixture, ownerAccount, peerAccount, report, peerReport,
  caseRecord, phase
}) {
  for (const reportId of [report.draftId, peerReport.draftId]) {
    const pathname = `/pm/daily-report/get?id=${id(reportId)}`
    const denied = await expectPermissionDenied(observerApi, pathname)
    check(caseRecord, `${phase}不能读取授权成员日报明细`, denied.passed, pathname)
  }
  const projectQuery = `${reportQuery('DAILY')}&projectId=${id(fixture.projectId)}`
  check(caseRecord, `${phase}不能读取专属项目分页`,
    (await expectPermissionDenied(observerApi, projectQuery)).passed, projectQuery)
  for (const type of TYPES) {
    assertEmptyPage(await observerApi.get(reportQuery(type)), `${phase}/${type}/team`)
    for (const account of [ownerAccount, peerAccount]) {
      assertEmptyPage(await observerApi.get(reportQuery(type, account.userId)),
        `${phase}/${type}/spoof-owner`)
    }
  }
  for (const type of ['WEEKLY', 'MONTHLY']) {
    assertEmptyPage(await ownerApi.get(reportQuery(type, peerAccount.userId)),
      `${type}/owner-cannot-read-peer`)
    assertEmptyPage(await peerApi.get(reportQuery(type, ownerAccount.userId)),
      `${type}/peer-cannot-read-owner`)
  }
  check(caseRecord, `${phase}团队及伪造归属筛选均为空且CRM不串非下属`, true,
    `owner=${ownerAccount.userId}; peer=${peerAccount.userId}; project=${fixture.projectId}`)
}

function statsSnapshot () {
  const dialog = [...document.querySelectorAll('.report-stats-dialog')].find((element) => {
    const style = window.getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden' && element.offsetHeight > 0
  })
  return {
    visible: Boolean(dialog),
    rows: [...(dialog?.querySelectorAll('.el-table__body tr') || [])]
      .map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent.trim())),
    selected: [...(dialog?.querySelectorAll('label.el-radio-button.is-active') || [])]
      .map((label) => label.textContent.trim())
  }
}

async function waitForStats (page, expected, period, scope, timeoutMs = 15000) {
  const periodLabel = { month: '本月', quarter: '本季度', year: '本年度' }[period]
  const scopeLabel = scope === 'self' ? '本人' : '团队（按数据权限）'
  const deadline = Date.now() + timeoutMs
  let actual
  do {
    actual = await page.evaluate(statsSnapshot)
    if (actual.visible && actual.selected.includes(periodLabel) &&
      actual.selected.includes(scopeLabel) &&
      JSON.stringify(actual.rows) === JSON.stringify(expected)) return actual
    if (Date.now() >= deadline) break
    await page.waitForTimeout(200)
  } while (Date.now() <= deadline)
  assert.fail(`${period}/${scope} statistics mismatch: actual=${JSON.stringify(actual)}; expected=${JSON.stringify(expected)}`)
}

export async function closeWorkbenchTeamBrowser (handle, outputDir, tag, caseRecord) {
  try {
    await handle.flushResponses?.()
    const tracePath = path.join(outputDir, `${tag}-team-trace.zip`)
    await handle.context.tracing.stop({ path: tracePath })
    caseRecord.evidence.push(tracePath)
  } catch (error) {
    caseRecord.checks.push({ name: '团队账号浏览器证据完整回收', passed: false, details: error.message })
  } finally {
    for (const target of [handle.context, handle.browser]) {
      try { await target.close() } catch (error) {
        caseRecord.checks.push({ name: '团队账号浏览器关闭', passed: false, details: error.message })
      }
    }
  }
}

export async function runWorkbenchTeamClosure ({
  adminApi, ownerAccount, ownerHandle, fixture, report, crmReportIds,
  registry, marker, caseRecord, record, outputDir, tools = {}
}) {
  const deps = {
    createOwnedAccount, newOwnedBrowser, createDrafts, createWorkbenchDailyReport,
    summarizeWorkbenchReports, waitForReportRendering,
    openRoute, saveScreenshot, ...tools
  }
  const complete = [false, false, false, false, false]
  const evidence = { steps: [], observerPhases: [], roles: [] }
  const handles = []
  const page = ownerHandle.page
  const dialog = page.locator('.report-stats-dialog').first()
  const capture = async (handle, action, scope = 'self') => {
    // Drain the previous document so a late login response cannot satisfy this batch.
    await handle.flushResponses?.()
    const captured = await (tools.captureOwnedWorkbenchReports || captureOwnedWorkbenchReports)(handle.page, action,
      handle.permission.user.id, scope)
    assert.deepEqual(captured.missing, [], 'Missing one of the three real report GETs')
    return captured.pages
  }
  const navigate = (handle) => deps.openRoute(handle.page, '/index', { readySelector: '.report-panel' })
  try {
    assert.match(marker, /^E2E-WBF-012-[A-Z0-9-]+$/)
    assert.equal(fixture.marker, marker)
    assert.equal(id(fixture.accountId), id(ownerAccount.userId))
    assert.equal(report.submitted.status, 'SUBMITTED')
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(page.url()).hostname))
    assert.equal(new URL(page.url()).port, '9151')
    const today = await page.evaluate(() => {
      const now = new Date()
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    })
    assert.equal(report.periodKey, today, 'Owned daily report must belong to the browser date')
    const menus = await restrictedMenus(adminApi)
    await verifyActor(adminApi, ownerAccount, ownerHandle, menus.peer.permissions, marker, caseRecord)
    const ownerCrmIds = await readCrmIds(ownerHandle.api, crmReportIds, ownerAccount.userId)
    const peer = await deps.createOwnedAccount({
      api: adminApi, registry, marker, menuIds: menus.peer.menuIds, tag: 'peer', caseRecord
    })
    const peerRole = await assignOwnedTeamRole({
      adminApi, registry, fixture, accountId: peer.userId,
      roleKind: 'REPORTER_PEER', marker, today
    })
    evidence.roles.push({ userId: peer.userId, roleId: peerRole.roleId, roleCode: peerRole.roleCode })
    const roles = data(await adminApi.getBusiness(`/pm/project-role/list?projectId=${id(fixture.projectId)}`))
    check(caseRecord, '独立peer角色不替换owner且两人均为当前有效项目成员',
      roles.some((row) => id(row.id) === id(fixture.roleId) &&
        id(row.userId) === id(ownerAccount.userId) && roleIsEffective(row, today)) &&
      roleIsEffective(peerRole.row, today), `ownerRole=${fixture.roleId}; peerRole=${peerRole.roleId}`)
    const peerHandle = await deps.newOwnedBrowser({
      account: peer, record, outputDir, caseRecord, tools
    })
    handles.push([peerHandle, peer.username])
    await verifyActor(adminApi, peer, peerHandle, menus.peer.permissions, marker, caseRecord)
    const peerCrmReportIds = await deps.createDrafts({
      account: peer, ownApi: peerHandle.api, registry, marker, today, caseRecord
    })
    const peerCrmIds = await readCrmIds(peerHandle.api, peerCrmReportIds, peer.userId)
    const peerReport = await deps.createWorkbenchDailyReport({
      adminApi, ownApi: peerHandle.api, account: peer, fixture, marker, caseRecord, periodKey: today
    })
    const ownerScope = {
      projectId: fixture.projectId, ownerId: ownerAccount.userId, peerId: peer.userId,
      ownerReportId: report.draftId, peerReportId: peerReport.draftId, crmIds: ownerCrmIds
    }
    assertCompleteTeamPages({
      pages: await capture(peerHandle, () => navigate(peerHandle)), scope: 'self',
      projectId: fixture.projectId, ownerId: peer.userId, peerId: ownerAccount.userId,
      ownerReportId: peerReport.draftId, peerReportId: report.draftId, crmIds: peerCrmIds
    })
    assertCompleteTeamPages({
      ...ownerScope, scope: 'self', pages: await capture(ownerHandle, () => navigate(ownerHandle))
    })
    const panel = page.locator('.report-panel').first()
    await panel.waitFor({ state: 'visible' })
    await deps.waitForReportRendering(panel)
    const steps = [
      { period: 'month', scope: 'self', action: () => panel.getByRole('button', { name: '统计', exact: true }).click() },
      { period: 'quarter', scope: 'self', label: '本季度' },
      { period: 'year', scope: 'self', label: '本年度' },
      { period: 'year', scope: 'team', label: '团队（按数据权限）' },
      { period: 'year', scope: 'self', label: '本人' }
    ]
    for (const [index, step] of steps.entries()) {
      const pages = await capture(ownerHandle, step.action || (() => dialog
        .locator('label.el-radio-button').filter({ hasText: step.label }).click()), step.scope)
      assertCompleteTeamPages({ ...ownerScope, pages, scope: step.scope })
      await dialog.waitFor({ state: 'visible' })
      await dialog.locator('.el-loading-mask').waitFor({ state: 'hidden', timeout: 15000 })
      const expected = deps.summarizeWorkbenchReports(pages, step.period, today)
      assert.equal(expected[0][1], step.scope === 'team' ? '2' : '1')
      assert.equal(expected[0][2], step.scope === 'team' ? '2' : '1')
      const actual = await waitForStats(page, expected, step.period, step.scope, deps.statsTimeoutMs)
      evidence.steps.push({
        period: step.period, scope: step.scope, expected, actual,
        requests: TYPES.map((type) => reportQuery(type, step.scope === 'self' ? ownerAccount.userId : undefined)),
        reports: Object.fromEntries(TYPES.map((type) => [type, pages[type].list.map((row) => ({
          id: id(row.id), ownerId: id(row[type === 'DAILY' ? 'reporterId' : 'ownerUserId']),
          status: row.status, ...(type === 'DAILY' ? { projectId: id(row.projectId), periodKey: row.periodKey }
            : { periodStart: row.periodStart, periodEnd: row.periodEnd })
        }))]))
      })
      check(caseRecord, `${step.period}/${step.scope}三份真实GET与三行四项统计精确一致`, true,
        JSON.stringify({ rows: expected, dailyIds: pages.DAILY.list.map((row) => id(row.id)) }))
      complete[0] = true
      complete[1] = true
      if (index === 2) complete[2] = true
      await deps.saveScreenshot(page, outputDir, `wbf012-${index}-${step.period}-${step.scope}`, record)
    }
    const observer = await deps.createOwnedAccount({
      api: adminApi, registry, marker, menuIds: menus.observer.menuIds, tag: 'observer', caseRecord
    })
    assert.equal(new Set([id(ownerAccount.userId), id(peer.userId), id(observer.userId)]).size, 3)
    const observerHandle = await deps.newOwnedBrowser({
      account: observer, record, outputDir, caseRecord, tools
    })
    handles.push([observerHandle, observer.username])
    await verifyActor(adminApi, observer, observerHandle, menus.observer.permissions, marker, caseRecord)
    const checkObserver = async (phase) => {
      const roles = data(await adminApi.getBusiness(`/pm/project-role/list?projectId=${id(fixture.projectId)}`))
      assert.ok(!roles.some((row) => id(row.userId) === id(observer.userId) && roleIsEffective(row, today)))
      await verifyTeamObserver({
        observerApi: observerHandle.api, ownerApi: ownerHandle.api, peerApi: peerHandle.api,
        ownerAccount, peerAccount: peer, fixture, report, peerReport, caseRecord, phase
      })
      const observed = await capture(observerHandle, () => navigate(observerHandle))
      for (const type of TYPES) assertEmptyPage({ code: 0, data: observed[type] }, `${phase}/workbench/${type}`)
      const observerPanel = observerHandle.page.locator('.report-panel').first()
      await deps.waitForReportRendering(observerPanel)
      const observerDialog = observerHandle.page.locator('.report-stats-dialog').first()
      try {
        await capture(observerHandle, () => observerPanel.getByRole('button', { name: '统计', exact: true }).click())
        await observerDialog.waitFor({ state: 'visible' })
        await observerDialog.locator('.el-loading-mask').waitFor({ state: 'hidden', timeout: 15000 })
        const teamPages = await capture(observerHandle, () => observerDialog.locator('label.el-radio-button')
          .filter({ hasText: '团队（按数据权限）' }).click(), 'team')
        for (const type of TYPES) assertEmptyPage({ code: 0, data: teamPages[type] }, `${phase}/stats-team/${type}`)
        await observerDialog.locator('.el-loading-mask').waitFor({ state: 'hidden', timeout: 15000 })
        const expected = deps.summarizeWorkbenchReports(teamPages, 'month', today)
        await waitForStats(observerHandle.page, expected, 'month', 'team', deps.statsTimeoutMs)
        check(caseRecord, `${phase}浏览器真实点击团队统计仍为三类零报告`, true,
          JSON.stringify(expected))
        await deps.saveScreenshot(observerHandle.page, outputDir, `wbf012-observer-${phase}`, record)
        const selfPages = await capture(observerHandle, () => observerDialog.locator('label.el-radio-button')
          .filter({ hasText: '本人' }).click())
        for (const type of TYPES) assertEmptyPage({ code: 0, data: selfPages[type] }, `${phase}/stats-self/${type}`)
        await observerDialog.locator('.el-loading-mask').waitFor({ state: 'hidden', timeout: 15000 })
        await waitForStats(observerHandle.page, expected, 'month', 'self', deps.statsTimeoutMs)
      } finally {
        if (await observerDialog.isVisible()) {
          await observerDialog.getByRole('button', { name: '关闭', exact: true }).click()
          await observerDialog.waitFor({ state: 'hidden' })
        }
      }
      assert.equal(new URL(observerHandle.page.url()).pathname, '/index')
      evidence.observerPhases.push(phase)
    }
    await checkObserver('nonmember')
    for (const [roleKind, effectiveStart, effectiveEnd, phase] of [
      ['REPORTER_FUTURE', shiftDate(today, 1), undefined, 'future'],
      ['REPORTER_EXPIRED', shiftDate(today, -2), shiftDate(today, -1), 'expired']
    ]) {
      const role = await assignOwnedTeamRole({
        adminApi, registry, fixture, accountId: observer.userId,
        roleKind, marker, today, effectiveStart, effectiveEnd
      })
      evidence.roles.push({ userId: observer.userId, roleId: role.roleId, roleCode: role.roleCode,
        effectiveStart, effectiveEnd })
      assert.ok(!roleIsEffective(role.row, today))
      await checkObserver(phase)
    }
    complete[3] = true
    check(caseRecord, '团队日报2条与本人1条形成真实差异且非下属CRM保持隔离', true,
      `project=${fixture.projectId}; owner=${ownerAccount.userId}; peer=${peer.userId}; observer=${observer.userId}`)
    return evidence
  } catch (error) {
    caseRecord.checks.push({ name: 'WBF-012闭环完整执行', passed: false, details: error.message })
    throw error
  } finally {
    try {
      if (await dialog.isVisible()) {
        await dialog.getByRole('button', { name: '关闭', exact: true }).click()
        await dialog.waitFor({ state: 'hidden' })
      }
      complete[4] = complete[0] && new URL(page.url()).pathname === '/index'
      if (complete[0]) check(caseRecord, '关闭统计后仍停留在工作台', complete[4],
        `pathname=${new URL(page.url()).pathname}`)
      if (complete[4]) await deps.saveScreenshot(page, outputDir, 'wbf012-closed-index', record)
    } finally {
      for (const [handle, tag] of handles.reverse()) {
        await closeWorkbenchTeamBrowser(handle, outputDir, tag, caseRecord)
      }
      caseRecord.workbenchTeamClosure = evidence
      for (const [index, passed] of complete.entries()) {
        recordCatalogAssertion(caseRecord, CASE_ID, index, passed ? 'VERIFIED' : 'UNVERIFIED',
          JSON.stringify({ stepCount: evidence.steps.length, observerPhases: evidence.observerPhases,
            completed: passed, route: new URL(page.url()).pathname }))
      }
    }
  }
}
