import { randomBytes } from 'node:crypto'
import { config } from '../config/index.mjs'
import { createApiClient } from '../lib/api.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { ExecutionWorkflowFixture } from '../fixtures/mes-execution-write.mjs'
import {
  assertPermissionLocal, openPermissionActor, ownedPermissionResources
} from './system-data-permission.mjs'

export const cases = ['MES-MONITOR-001']
export const catalogAssertions = [
  '车间列表按当前登录用户部门与子部门过滤且字段完整',
  '生产看板按车间返回 lines/alarms/trends 结构化数据',
  '每条预警带 alarmKey、sourceType(DEVICE/WORK) 与 sourceId 可下钻',
  '预警派发只写台账与站内通知，不修改生产状态'
]
const unwrap = (response) => {
  assertBusinessSuccess(response, 'MES monitor')
  return response.data
}
const numericId = (value) => {
  if (!/^[1-9]\d*$/.test(String(value ?? '')) ||
      (typeof value === 'number' && !Number.isSafeInteger(value))) throw new Error('Invalid monitor fixture ID')
  return String(value)
}
const addCheck = (record, name, passed, details = '') => {
  record.checks.push({ name, passed: Boolean(passed), details })
  return name
}
const map = (record, index, names) => {
  const row = record.catalogAssertions[index]
  const checks = names.map((name) => record.checks.find((check) => check.name === name))
  row.evidenceChecks = names
  row.status = checks.some((check) => check?.passed === false) ? 'FAILED'
    : checks.length > 0 && checks.every((check) => check?.passed === true) ? 'VERIFIED' : 'GAP'
}

export function monitorAlarmFields (alarms) {
  return Array.isArray(alarms) && alarms.length > 0 &&
    new Set(alarms.map((alarm) => alarm.alarmKey)).size === alarms.length &&
    alarms.every((alarm) => ['DEVICE', 'WORK'].includes(alarm?.sourceType) &&
      /^[1-9]\d*$/.test(String(alarm?.sourceId ?? '')) &&
      alarm.alarmKey === `${alarm.sourceType === 'WORK' ? 'WORK_OVERDUE' : 'DEVICE_ALARM'}:${alarm.sourceId}`)
}

export function monitorDispatchEvidence (snapshot, alarmKey, receiverId) {
  return snapshot?.available === true && snapshot.rows?.length === 1 &&
    snapshot.rows.every((row) => /^[1-9]\d*$/.test(row[0]) &&
      row[1] === alarmKey && row[2] === String(receiverId) &&
      /^[1-9]\d*$/.test(row[3]) && row[3] === row[4] &&
      row[5] === String(receiverId) && row[6] === 'mes_monitor_alarm' && row[7] === alarmKey)
}

export async function monitorPageSnapshot (page) {
  return page.evaluate(() => ({
    url: window.location.href,
    title: document.title,
    bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1800),
    shell: Boolean(document.querySelector('.ioc-shell')),
    routeSkeletons: document.querySelectorAll('.route-skeleton, .el-skeleton').length,
    monitorResources: performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) => /mes\/monitor|MesProductionMonitor/.test(url))
      .slice(-12)
  })).catch((error) => ({ snapshotError: String(error?.message || error) }))
}

export async function verifyMonitorPage (page, { workplace, lineId, alarmKey }, dependencies = {}) {
  const pageErrors = []
  const consoleErrors = []
  const requestFailures = []
  const onPageError = (error) => pageErrors.push(error.message)
  const onConsole = (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  }
  const onRequestFailed = (request) => {
    requestFailures.push({
      url: request.url(),
      error: request.failure()?.errorText || 'unknown'
    })
  }
  page.on('pageerror', onPageError)
  page.on('console', onConsole)
  page.on('requestfailed', onRequestFailed)
  try {
    try {
      await (dependencies.openRoute || openRoute)(page, '/mes/monitor', {
        readySelector: '.ioc-shell .command-strip',
        readyTimeoutMs: 20000
      })
    } catch (error) {
      const diagnostics = {
        page: await monitorPageSnapshot(page),
        pageErrors: pageErrors.slice(-8),
        consoleErrors: consoleErrors.slice(-8),
        requestFailures: requestFailures.slice(-8)
      }
      throw new Error(`${error.message}; monitor actor diagnostics=${JSON.stringify(diagnostics)}`)
    }
  await page.locator('.workplace-select').click()
  await page.getByRole('option', { name: workplace.payload.name, exact: true }).click()
  await page.locator('.command-title strong').filter({ hasText: workplace.payload.name }).waitFor()
  const [response] = await Promise.all([
    page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === '/admin-api/mes/monitor/production-dashboard' &&
        url.searchParams.get('workplaceId') === workplace.id && response.status() === 200
    }),
    page.getByRole('button', { name: '刷新生产看板', exact: true }).click()
  ])
  const dashboard = unwrap(await response.json())
  if (String(dashboard?.workplace?.id) !== workplace.id ||
      !Array.isArray(dashboard.lines) || dashboard.lines.length !== 1 ||
      String(dashboard.lines[0].lineId) !== lineId ||
      !monitorAlarmFields(dashboard.alarms) ||
      dashboard.alarms.length !== 1 || dashboard.alarms[0].alarmKey !== alarmKey) {
    throw new Error('Monitor browser response did not match the owned workplace/line/alarm')
  }
  await page.locator(`.line-tile[data-line-id="${lineId}"]`).waitFor({ state: 'visible' })
  await page.locator(`.alarm-card[data-alarm-key="${alarmKey}"]`).waitFor({ state: 'visible' })
  return { route: '/mes/monitor', workplaceId: workplace.id, lineId, alarmKey, status: 'VERIFIED' }
  } finally {
    page.off('pageerror', onPageError)
    page.off('console', onConsole)
    page.off('requestfailed', onRequestFailed)
  }
}

class MonitorOrganization {
  constructor (api, sql, caseRecord, marker) {
    Object.assign(this, { api, sql, caseRecord, marker })
    this.resources = []
    this.retainRoot = false
  }

  async create (kind, payload) {
    const definition = {
      dept: ['system_dept', '/system/dept/create', '/system/dept/get', '/system/dept/delete'],
      workplace: ['mes_work_place', '/mes/mesWorkPlace/add', '/mes/mesWorkPlace/queryById', '/mes/mesWorkPlace/delete'],
      line: ['mes_work_line', '/mes/mesWorkLine/add', '/mes/mesWorkLine/queryById', '/mes/mesWorkLine/delete']
    }[kind]
    // MES create returns a success message, so also retain the unique code before the first SQL lookup.
    const resource = { kind, code: payload.code, payload, definition, marker: this.marker, cleanup: 'PENDING' }
    this.resources.push(resource)
    this.caseRecord.fixtureResiduals = [...(this.caseRecord.fixtureResiduals || []), resource]
    const value = unwrap(await this.api.postBusiness(definition[1], payload))
    if (kind === 'dept') resource.id = numericId(value)
    else await this.resolve(resource)
    this.caseRecord.businessIds = this.caseRecord.businessIds || {}
    this.caseRecord.businessIds[kind] = [...(this.caseRecord.businessIds[kind] || []), resource.id]
    await this.read(resource)
    return resource
  }

  async resolve (resource) {
    if (resource.id) return
    if (!/^[A-Za-z0-9_-]+$/.test(resource.code)) throw new Error('Unsafe organization code')
    const found = await this.sql(`SELECT CAST(id AS CHAR) FROM ${resource.definition[0]}
      WHERE tenant_id=1 AND deleted=0 AND code='${resource.code}'`)
    if (!found.available || found.rows.length !== 1) throw new Error('Owned organization ID lookup failed')
    resource.id = numericId(found.rows[0][0])
  }

  async read (resource) {
    const row = unwrap(await this.api.getBusiness(`${resource.definition[2]}?id=${resource.id}`))
    const keys = resource.kind === 'dept' ? ['code', 'name', 'parentId'] : ['code', 'name', 'remark']
    if (String(row?.id) !== resource.id || keys.some((key) =>
      String(row?.[key]) !== String(resource.payload[key]))) throw new Error('Monitor organization ownership mismatch')
    return row
  }

  async cleanup () {
    for (const resource of [...this.resources].reverse()) {
      try {
        await this.resolve(resource)
        await this.read(resource)
        const retainedUserDept = this.retainRoot && resource === this.root
        if (retainedUserDept) {
          unwrap(await this.api.putBusiness('/system/dept/update', { ...resource.payload, id: resource.id, status: 1 }))
          if (Number((await this.read(resource)).status) !== 1) throw new Error('Audit department disable failed')
          resource.cleanup = 'RETAINED_AUDIT_DISABLED'
        } else {
          unwrap(await this.api.deleteBusiness(`${resource.definition[3]}?id=${resource.id}`))
          const snapshot = await this.sql(`SELECT COUNT(*) FROM ${resource.definition[0]}
            WHERE tenant_id=1 AND deleted=0 AND id=${resource.id}`)
          if (!snapshot.available || snapshot.rows?.[0]?.[0] !== '0') throw new Error('Organization deletion not verified')
          resource.cleanup = 'DELETED_VERIFIED'
        }
        addCheck(this.caseRecord, `monitor ${resource.kind} ${resource.id} 清理回读`, true, resource.cleanup)
      } catch (error) {
        resource.cleanup = 'RETAINED_UNVERIFIED'
        resource.reason = error.message
        addCheck(this.caseRecord, `monitor ${resource.kind} ${resource.id || resource.code} 清理回读`, false, error.message)
      }
    }
  }
}

export const runCase = async (context, dependencies = {}) => {
  const { page, record, caseRecord, outputDir } = context
  caseRecord.catalogAssertions = catalogAssertions.map((assertion, index) => ({
    index, assertion, status: 'GAP', evidenceChecks: []
  }))
  const settings = dependencies.settings || config
  const sql = dependencies.sql || runReadOnlySql
  const apiFactory = dependencies.createApiClient || createApiClient
  let api, actor, fixture, owned, organization
  try {
    assertPermissionLocal(settings, dependencies.env || process.env)
    await (dependencies.writeSafety || assertLocalWriteSafety)(caseRecord)
    const token = await (dependencies.login || login)(page)
    api = apiFactory({ token, record })
    const marker = `E2E-MON-${randomBytes(5).toString('hex')}`
    organization = new MonitorOrganization(api, sql, caseRecord, marker)
    organization.root = await organization.create('dept', {
      code: `${marker}-ROOT`, name: `${marker}-ROOT`, parentId: 0, sort: 99, status: 0
    })
    const child = await organization.create('dept', {
      code: `${marker}-CHILD`, name: `${marker}-CHILD`, parentId: organization.root.id, sort: 99, status: 0
    })
    const outside = await organization.create('dept', {
      code: `${marker}-OUT`, name: `${marker}-OUT`, parentId: 0, sort: 99, status: 0
    })
    owned = ownedPermissionResources(api, caseRecord, marker)
    const rolePayload = { name: marker, code: marker.replaceAll('-', '_'), remark: marker, sort: 99, status: 0 }
    const role = owned.remember('role', unwrap(await api.postBusiness('/system/role/create', rolePayload)), rolePayload)
    await owned.read(role)
    const menuRows = unwrap(await api.getBusiness('/system/menu/list'))
    const flatten = (rows) => (Array.isArray(rows) ? rows : []).flatMap((row) => [row, ...flatten(row.children)])
    const allMenus = flatten(menuRows)
    const monitorMenu = allMenus.find((row) => row.component === 'mes/monitor/index' && Number(row.status) === 0)
    const homeMenu = allMenus.find((row) => row.component === 'Home/SystemIndex' && Number(row.status) === 0)
    const actorMenu = monitorMenu || homeMenu
    if (!actorMenu) throw new Error('BLOCKED: enabled monitor/home menu missing')
    const byId = new Map(allMenus.map((row) => [String(row.id), row]))
    const menuIds = new Set()
    let current = actorMenu
    while (current) {
      const key = numericId(current.id)
      if (menuIds.has(key) || Number(current.status) !== 0 ||
          (current.permission && !current.permission.endsWith(':query'))) {
        throw new Error('BLOCKED: monitor menu ancestor would grant unrelated mutation permission')
      }
      menuIds.add(key)
      if (String(current.parentId ?? 0) === '0') break
      current = byId.get(String(current.parentId))
      if (!current) throw new Error('Monitor actor menu ancestor missing')
    }
    unwrap(await api.postBusiness('/system/permission/assign-role-menu', { roleId: role.id, menuIds: [...menuIds] }))
    const actualMenus = unwrap(await api.getBusiness(`/system/permission/list-role-menus?roleId=${role.id}`))
    if (!Array.isArray(actualMenus) || JSON.stringify(actualMenus.map(String).sort()) !==
        JSON.stringify([...menuIds].sort())) throw new Error('Monitor actor menu isolation failed')
    unwrap(await api.postBusiness('/system/permission/assign-role-data-scope', {
      roleId: role.id, dataScope: 1, dataScopeDeptIds: []
    }))
    caseRecord.notes.push('通用生产行级范围 ALL 用于读取管理员创建的专属链路；车间部门边界仍由真实账号部门及子部门判断，并以兄弟部门车间的精确 403 作反例。')
    const credentials = {
      username: `e2emon${randomBytes(6).toString('hex')}`, nickname: marker, remark: marker,
      password: `Mn!${randomBytes(5).toString('hex')}`, sex: 0, postIds: [],
      deptId: organization.root.id, roleIds: [role.id]
    }
    const user = owned.remember('user', unwrap(await api.postBusiness('/system/user/create', credentials)), credentials)
    await owned.read(user)
    const roles = unwrap(await api.getBusiness(`/system/permission/list-user-roles?userId=${user.id}`))
    if (!Array.isArray(roles) || roles.length !== 1 || String(roles[0]) !== role.id) throw new Error('Monitor actor role isolation failed')
    const places = []
    for (const [suffix, dept] of [['ROOT', organization.root], ['CHILD', child], ['OUT', outside]]) {
      places.push(await organization.create('workplace', {
        code: `${marker}-${suffix}`, name: `${marker}-${suffix}`, remark: marker,
        sysOrgCode: dept.id, status: '0', chargeId: user.id
      }))
    }
    const line = await organization.create('line', {
      code: `${marker}-LINE`, name: `${marker}-LINE`, remark: marker,
      sysOrgCode: child.id, workPlaceId: places[1].id, status: 0, type: '1'
    })
    actor = await (dependencies.headedActor || openPermissionActor)({ ...context, credentials, settings })
    const actorApi = apiFactory({ token: actor.token, record })
    const profile = unwrap(await actorApi.getBusiness('/system/user/profile/get'))
    const identity = addCheck(caseRecord, '受限账号真实身份与部门回读',
      String(profile?.id) === user.id && String(profile?.dept?.id) === organization.root.id)
    const workplaces = unwrap(await actorApi.getBusiness('/mes/monitor/workplaces'))
    const filter = addCheck(caseRecord, '本部门及子部门车间可见且兄弟部门车间不可见',
      Array.isArray(workplaces) && [places[0], places[1]].every((place) =>
        workplaces.some((row) => String(row.id) === place.id)) &&
      !workplaces.some((row) => String(row.id) === places[2].id) &&
      workplaces.every((row) => row.id != null && typeof row.code === 'string' && row.code.length > 0 &&
        typeof row.name === 'string' && row.name.length > 0 && Object.hasOwn(row, 'description')))
    const denied = await actorApi.request('GET',
      `/mes/monitor/production-dashboard?workplaceId=${places[2].id}`, undefined, {
        expectedBusinessRejection: {
          code: 403, message: '无权查看该车间的生产看板', allowServiceCode: true
        }
      })
    const negative = addCheck(caseRecord, '显式越权车间看板精确拒绝',
      denied?.code === 403 && (denied.msg ?? denied.message) === '无权查看该车间的生产看板' &&
      denied.success !== true)
    map(caseRecord, 0, [identity, filter, negative])

    // Constrain the shared execution fixture's workplace selection to this run's owned workplace.
    const scopedApi = {
      ...api,
      getBusiness: async (path, options) => {
        if (path !== '/mes/monitor/workplaces') return api.getBusiness(path, options)
        const visible = unwrap(await api.getBusiness(path))
        const place = visible?.find((row) => String(row.id) === places[1].id)
        if (!place) throw new Error('Owned monitor workplace not visible to fixture creator')
        return { code: 0, data: [place] }
      }
    }
    const Fixture = dependencies.ExecutionWorkflowFixture || ExecutionWorkflowFixture
    fixture = new Fixture(scopedApi, record, cases[0], { overdue: true, withOpeningInventory: true })
    await fixture.setup(caseRecord)
    if (String(fixture.workplace.id) !== places[1].id || String(fixture.lineId) !== line.id) {
      throw new Error('BLOCKED: execution fixture escaped owned monitor workplace/line')
    }
    const dashboard = unwrap(await actorApi.getBusiness(
      `/mes/monitor/production-dashboard?workplaceId=${places[1].id}`))
    map(caseRecord, 1, [addCheck(caseRecord, '专属车间看板结构及产线归属',
      String(dashboard?.workplace?.id) === places[1].id &&
      Array.isArray(dashboard.lines) && dashboard.lines.length === 1 &&
      String(dashboard.lines[0].lineId) === line.id &&
      Array.isArray(dashboard.alarms) && Array.isArray(dashboard.trends))])
    const alarms = dashboard?.alarms
    const alarmKey = `WORK_OVERDUE:${numericId(fixture.works[0].id)}`
    const alarmFields = addCheck(caseRecord, '逐条预警来源字段及非空专属工单反例',
      monitorAlarmFields(alarms) && alarms.length === 1 && alarms[0].alarmKey === alarmKey)
    const drilldowns = []
    for (const alarm of Array.isArray(alarms) ? alarms : []) {
      const endpoint = alarm.sourceType === 'WORK' ? '/mes/prodWork/queryById' : '/iot/device/get'
      const detail = unwrap(await api.getBusiness(`${endpoint}?id=${numericId(alarm.sourceId)}`))
      drilldowns.push(addCheck(caseRecord, `预警 ${alarm.alarmKey} 来源下钻`,
        String(detail?.id) === String(alarm.sourceId) && detail.remark === fixture.marker))
    }
    map(caseRecord, 2, [alarmFields, ...drilldowns])
    if (!caseRecord.checks.find((row) => row.name === alarmFields)?.passed) {
      throw new Error('BLOCKED: dispatch may only address this run owned WORK alarm')
    }
    const snapshot = async () => {
      const state = []
      for (const [kind, resource] of [['prodOrder', fixture.order], ['prodWork', fixture.works[0]], ['prodWorkTask', fixture.tasks[0]]]) {
        const row = unwrap(await api.getBusiness(`/mes/${kind}/queryById?id=${numericId(resource.id)}`))
        if (String(row?.id) !== String(resource.id) || row.status == null) throw new Error('Production status readback missing')
        state.push(Object.fromEntries(['id', 'status', 'reportVersion', 'goodCount', 'badCount', 'reportCount', 'outputCount']
          .filter((key) => Object.hasOwn(row, key)).map((key) => [key, row[key]])))
      }
      return state
    }
    const ledger = () => sql(`SELECT CAST(d.id AS CHAR),d.alarm_key,CAST(d.receiver_id AS CHAR),
      CAST(d.notify_message_id AS CHAR),CAST(n.id AS CHAR),CAST(n.user_id AS CHAR),n.template_code,
      JSON_UNQUOTE(JSON_EXTRACT(n.template_params,'$.alarmKey'))
      FROM mes_monitor_alarm_dispatch d LEFT JOIN system_notify_message n
      ON n.id=d.notify_message_id AND n.tenant_id=1 AND n.deleted=0
      WHERE d.tenant_id=1 AND d.deleted=0 AND d.alarm_key='${alarmKey}' AND d.dispatch_date=CURDATE()`)
    const before = await snapshot()
    const emptyLedger = await ledger()
    if (!emptyLedger.available || emptyLedger.rows.length !== 0) throw new Error('Owned alarm ledger already exists before dispatch')
    owned.retainForAudit()
    organization.retainRoot = true
    const audit = { kind: 'monitor-dispatch', alarmKey, receiverId: user.id, cleanup: 'RETAINED_AUDIT', retainedState: true }
    caseRecord.fixtureResiduals.push(audit)
    const dispatch = unwrap(await actorApi.postBusiness(`/mes/monitor/alarms/dispatch?workplaceId=${places[1].id}`, {}))
    const dispatched = addCheck(caseRecord, '只派发本轮专属预警',
      dispatch?.scannedCount === 1 && dispatch.dispatchedCount === 1 && dispatch.skippedCount === 0 &&
      dispatch.items?.length === 1 && dispatch.items[0].alarmKey === alarmKey && dispatch.items[0].dispatched === true)
    const afterLedger = await ledger()
    // Retain IDs even when the dispatch response or notification evidence is incorrect.
    audit.dispatchIds = (afterLedger.rows || []).map((row) => row[0])
    audit.notificationIds = (afterLedger.rows || []).map((row) => row[3]).filter((value) => /^[1-9]\d*$/.test(value))
    const notified = addCheck(caseRecord, '派发台账与本轮接收人站内信关联真实落库',
      monitorDispatchEvidence(afterLedger, alarmKey, user.id))
    const afterFirst = await snapshot()
    const repeated = unwrap(await actorApi.postBusiness(`/mes/monitor/alarms/dispatch?workplaceId=${places[1].id}`, {}))
    const repeatedLedger = await ledger()
    const idempotent = addCheck(caseRecord, '同日重复派发不增加台账或站内信',
      repeated?.scannedCount === 1 && repeated.dispatchedCount === 0 && repeated.skippedCount === 1 &&
      JSON.stringify(afterLedger.rows) === JSON.stringify(repeatedLedger.rows) &&
      monitorDispatchEvidence(repeatedLedger, alarmKey, user.id))
    const unchanged = addCheck(caseRecord, '首次及重复派发前后计划工单任务状态一致',
      JSON.stringify(before) === JSON.stringify(afterFirst) &&
      JSON.stringify(before) === JSON.stringify(await snapshot()),
      JSON.stringify({ before, afterFirst }))
    map(caseRecord, 3, [dispatched, notified, idempotent, unchanged])
    const viewPage = actor.page
    caseRecord.uiEvidence = { route: '/mes/monitor', status: 'GAP' }
    caseRecord.uiEvidence = await (dependencies.verifyMonitorPage || verifyMonitorPage)(viewPage, {
      workplace: places[1], lineId: line.id, alarmKey
    }, dependencies)
    addCheck(caseRecord, 'headed 真实页面选中专属车间并展示同一产线及预警',
      caseRecord.uiEvidence.status === 'VERIFIED' &&
      caseRecord.uiEvidence.workplaceId === places[1].id &&
      caseRecord.uiEvidence.lineId === line.id && caseRecord.uiEvidence.alarmKey === alarmKey)
    await (dependencies.saveScreenshot || saveScreenshot)(viewPage, outputDir, 'mes-monitor-owned-department-alarms', record)
    caseRecord.evidence.push(`owned workplace=${places[1].id}; alarm=${alarmKey}; 台账与通知保留审计，接收账号/角色/所属部门停用保留；无共享车间派发`)
  } finally {
    try {
      if (actor) await actor.close()
    } finally {
      try {
        if (fixture) await fixture.cleanup(caseRecord)
      } finally {
        try {
          if (owned) await owned.cleanup()
        } finally {
          if (organization) await organization.cleanup()
          caseRecord.remainingAssertions = caseRecord.catalogAssertions
            .filter((row) => row.status !== 'VERIFIED').map((row) => row.assertion)
          caseRecord.catalogComplete = caseRecord.remainingAssertions.length === 0
        }
      }
    }
  }
  return { api, partial: !caseRecord.catalogComplete || caseRecord.uiEvidence?.status !== 'VERIFIED' }
}
