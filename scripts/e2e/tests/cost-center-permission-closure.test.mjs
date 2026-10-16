import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  COST_CENTER_PERMISSION_CHECKS,
  hasCostCenterPermissionEvidence,
  preflightCostCenterPermissionClosure,
  resolveCostCenterPermissionMenus,
  runCostCenterPermissionClosure
} from '../fixtures/cost-center-permission-closure.mjs'
import { costCatalogBindings, costCatalogEvidence, runCase } from '../suites/cost.mjs'

const settings = {
  target: 'local', tenantId: '1', apiBase: 'http://127.0.0.1:48083',
  webBase: 'http://127.0.0.1:9151', tenantName: 'CFOR 标准平台', browserTimeoutMs: 100
}
const clone = (value) => structuredClone(value)
const ok = (data) => ({ code: 0, data })
const permissions = [
  'cost:center:query', 'cost:workspace-state:query',
  'cost:center:create', 'cost:center:update', 'cost:center:deactivate'
]
const menus = () => [
  { id: '1', parentId: '0', status: 0, type: 1, path: '/cost-management' },
  { id: '2', parentId: '1', status: 0, type: 1, path: 'modeling' },
  { id: '3', parentId: '2', status: 0, type: 2, path: 'profile',
    component: 'cost-management/section/index.vue?page=profile' },
  { id: '4', parentId: '0', status: 0, type: 1, path: '/__legacy__/cost', visible: false },
  ...permissions.map((permission, index) =>
    ({ id: String(10 + index), parentId: '4', status: 0, type: 3, permission }))
]
const deptId = '2110019776332775425'
const centerId = '2110019776332775427'
const firstId = '2110019776332775426'

class Locator {
  constructor (page, selector = '', text) { Object.assign(this, { page, selector, text }) }
  locator (selector) { return new Locator(this.page, `${this.selector} ${selector}`.trim()) }
  filter () { return this }
  getByText (text) { return new Locator(this.page, this.selector, text) }
  getByRole (role, { name }) { return new Locator(this.page, this.selector, name) }
  async count () {
    const { page, selector, text } = this
    const opts = page.h.opts
    if (page.h.uiSaved && text === page.h.department.name) {
      assert.ok(selector.includes('.department-table') && selector.includes('td:nth-child(3)'),
        'saved refresh must verify the department name column, not duplicate hierarchy text')
      if (opts.uiDepartmentNameMissing) return 0
    }
    if (opts.domFailure) throw new Error('actual DOM failure')
    if (selector.includes('cost-center-editor-dialog') || selector.includes('cost-center-deactivate-dialog')) {
      if (!page.child) return 0
    } else if (selector.includes('cost-center-management-dialog') && !page.manage) return 0
    if (['新增', '编辑成本中心', '停用'].includes(text) &&
        !selector.includes('cost-center-editor-dialog')) {
      return page.key === 'maintenance' || opts.readerButtonPresent ? 1 : 0
    }
    if (selector.includes('.center-summary') && text === '已启用' && opts.domDisabled) return 0
    return 1
  }
  async waitFor ({ state }) {
    if (state === 'visible') assert.equal(await this.count(), 1, this.text || this.selector)
    if (state === 'hidden') assert.equal(this.page.child, null)
  }
  async isEnabled () { return !this.page.h.opts.buttonDisabled }
  async isDisabled () { return !this.page.h.opts.codeEditable }
  async inputValue () {
    return this.page.h.opts.wrongEditorCode ? 'FOREIGN' : this.page.h.active.code
  }
  async fill (value) { this.page.search = value }
  async click () {
    const page = this.page
    page.h.clicks.push([page.key, this.text])
    if (this.text === '管理成本中心') page.manage = true
    if (['新增', '编辑成本中心', '停用'].includes(this.text)) {
      page.child = this.text
      if (page.h.opts.pageWrite) page.handlers.request?.({
        url: () => 'http://127.0.0.1:48083/admin-api/cost/centers',
        method: () => 'POST'
      })
    }
    if (this.text === '取消') page.child = null
    if (this.text === '保存') {
      const body = {
        accountingOrgId: 1, code: page.h.active.code, name: page.h.active.name,
        enabledAt: page.h.active.enabledAt, departmentIds: [deptId], remark: page.h.active.remark
      }
      if (page.h.opts.lossyUiId) body.departmentIds = [Number(deptId)]
      if (page.h.opts.foreignUiCenter) body.code = 'FOREIGN'
      const request = {
        url: () => `http://127.0.0.1:48083/admin-api/cost/centers/${centerId}`,
        method: () => 'PUT', postDataJSON: () => clone(body)
      }
      const route = {
        request: () => request,
        async continue () {
          page.h.apiRevision++
          page.h.dbRevision++
          page.h.relationRevision++
          page.h.uiSaved = true
          if (page.h.opts.uiRelationDrift) page.h.uiRelationDrift = true
          if (page.h.opts.uiDepartmentDrift) page.h.deptRow.name = 'FOREIGN'
          page.child = null
          const response = {
            request: () => request, url: request.url,
            status: () => 200, json: async () => ok(clone(page.h.active))
          }
          assert.equal(page.responsePredicate(response), true)
          page.resolveResponse(response)
        },
        async abort () { page.rejectResponse(new Error('guarded UI request aborted')) }
      }
      page.handlers.request?.(request)
      await page.routeHandler(route)
    }
  }
}

function harness (opts = {}) {
  const h = {
    opts, calls: [], sql: [], logins: [], screenshots: [], clicks: [], contexts: [],
    roles: new Map(), users: new Map(), grants: new Map(), bindings: new Map(), sessions: new Map(),
    menuRows: menus(), dbRevision: 0, relationRevision: 0, apiRevision: 0
  }
  h.record = { runId: 'permission-run', environment: { tenantId: '1' }, api: [] }
  h.caseRecord = { id: 'COST-029', fixtures: {}, checks: [], notes: [], evidence: [] }
  h.department = {
    id: deptId, name: 'E2E-COST-029-abcdef123456',
    marker: 'CFOR-E2E:COST-029:permission-run:tenant=1:department'
  }
  h.caseRecord.fixtures.costDepartment = h.department
  h.deptRow = { id: deptId, name: h.department.name, code: h.department.name, status: 0 }
  h.active = {
    id: centerId, accountingOrgId: 1, code: 'E2E-CC2-OWN', name: 'E2E active center',
    status: 'ENABLED', enabledAt: '2026-10-15', disabledAt: null,
    departmentIds: [deptId], departmentNames: [h.department.name], departmentCount: 1,
    referenceCount: 0, remark: '', updateTime: '2026-10-14 10:00:00'
  }
  h.first = { ...clone(h.active), id: firstId, code: 'E2E-CC-OWN', name: 'E2E first center',
    enabledAt: '2026-10-14', disabledAt: '2026-10-14', status: 'DISABLED' }
  const detail = () => ({ ...clone(h.active), updateTime: `api-revision-${h.apiRevision}` })
  const urlOf = (path) => new URL(path, 'http://fixture.invalid')
  const recordCall = (method, path, body) => h.calls.push({ method, path, body: clone(body) })
  h.api = {
    async getBusiness (path) {
      recordCall('GET', path)
      const u = urlOf(path)
      const key = u.searchParams.get('id')
      if (path === '/system/auth/get-permission-info') {
        return ok(opts.operatorMissing ? { user: { id: '5' }, roles: ['limited'], permissions: [] }
          : { user: { id: '5' }, roles: ['tenant_admin'], permissions: [] })
      }
      if (path === '/system/menu/list') return ok(h.menuRows)
      if (path === '/system/menu/list-all-simple') return ok(opts.packageMissing ? h.menuRows.slice(1) : h.menuRows)
      if (u.pathname === '/system/dept/get') return ok(opts.adminDeptNull ? null : clone(h.deptRow))
      if (u.pathname === '/system/role/get') {
        const row = clone(h.roles.get(key))
        if (opts.roleScopeDrift && row?.dataScope === 2) row.dataScope = 1
        if (opts.roleIdentityDrift && row) row.remark = 'FOREIGN'
        return ok(row)
      }
      if (u.pathname === '/system/permission/list-role-menus') {
        const grant = h.grants.get(u.searchParams.get('roleId')) || []
        return ok(opts.extraRoleMenu ? [...grant, '99'] : grant)
      }
      if (u.pathname === '/system/permission/list-user-roles') {
        const roles = h.bindings.get(u.searchParams.get('userId')) || []
        return ok(opts.extraUserRole ? [...roles, '99'] : roles)
      }
      if (u.pathname === '/system/user/get') {
        const row = clone(h.users.get(key))
        if (opts.userDrift && row) row.username = 'FOREIGN'
        return ok(row)
      }
      if (path === `/cost/centers/${centerId}`) return ok(detail())
      throw new Error(`unexpected formal GET ${path}`)
    },
    async postBusiness (path, body) {
      recordCall('POST', path, body)
      if (path === '/system/role/create') {
        const roleId = String(2110019776332776000n + BigInt(h.roles.size))
        h.roles.set(roleId, { ...body, id: roleId, type: 2, dataScope: 5, dataScopeDeptIds: [] })
        return ok(opts.lossyRoleId ? Number(roleId) : roleId)
      }
      if (path === '/system/permission/assign-role-menu') {
        h.grants.set(body.roleId, body.menuIds)
        return ok(true)
      }
      if (path === '/system/permission/assign-role-data-scope') {
        if (opts.customRejected) return { code: 400, msg: '数据范围包含不存在或不属于当前租户的部门' }
        Object.assign(h.roles.get(body.roleId), { dataScope: body.dataScope, dataScopeDeptIds: body.dataScopeDeptIds })
        return ok(true)
      }
      if (path === '/system/user/create') {
        h.secret = body.password
        if (opts.userCreateFailure) {
          h.record.api.push({ bodySummary: `password=${body.password}; denied` })
          throw new Error(`password=${body.password}; create refused`)
        }
        const userId = String(2110019776332777000n + BigInt(h.users.size))
        h.users.set(userId, { ...body, id: userId, status: 0 })
        return ok(userId)
      }
      if (path === '/system/permission/assign-user-role') {
        assert.equal(h.roles.get(body.roleIds[0]).dataScope, 2)
        h.bindings.set(body.userId, body.roleIds)
        return ok(true)
      }
      throw new Error(`unexpected formal POST ${path}`)
    },
    async putBusiness (path, body) {
      recordCall('PUT', path, body)
      if (path === '/system/user/update-status') {
        if (opts.disableUserFailure) throw new Error('user disable rejected')
        h.users.get(body.id).status = body.status
        return ok(true)
      }
      if (path === '/system/role/update') {
        if (opts.disableRoleFailure) return ok(false)
        h.roles.get(body.id).status = body.status
        return ok(true)
      }
      throw new Error(`unexpected formal PUT ${path}`)
    }
  }
  const makePage = (context) => ({
    context: () => context,
    key: '', currentUrl: 'about:blank', manage: false, child: null, handlers: {}, h,
    url () { return this.currentUrl },
    async bringToFront () {
      if (opts.focusFailure) throw new Error('actual foreground switch failed')
      h.foregroundPage = this
      this.focusCount = (this.focusCount || 0) + 1
    },
    async route (matcher, handler) { this.routeHandler = handler },
    async unroute (matcher, handler) {
      assert.equal(this.routeHandler, handler)
      this.routeHandler = null
    },
    waitForResponse (predicate) {
      this.responsePredicate = predicate
      return new Promise((resolve, reject) => {
        this.resolveResponse = resolve
        this.rejectResponse = reject
      })
    },
    on (event, fn) { this.handlers[event] = fn },
    locator (selector) { return new Locator(this, selector) },
    getByRole (role, options) { return new Locator(this).getByRole(role, options) },
    async reload () {
      this.manage = false
      this.child = null
      this.reloaded = (this.reloaded || 0) + 1
    }
  })
  h.adminContext = { browser: () => h.browser }
  h.adminPage = makePage(h.adminContext)
  h.adminPage.currentUrl = 'http://127.0.0.1:9151/admin-original'
  h.browser = {
    async newContext () {
      if (opts.sharedAdminContext) return h.adminContext
      const context = {
        browser: () => h.browser, closed: false,
        setDefaultTimeout () {},
        async newPage () {
          this.page = makePage(this)
          return this.page
        },
        async close () {
          this.closed = true
          if (opts.closeFailure) throw new Error('context close failed')
        },
        tracing: { start () { throw new Error('credential tracing forbidden') } }
      }
      h.contexts.push(context)
      return context
    }
  }
  const sqlCenter = (row) => ({
    id: row.id, tenant_id: '1', accounting_org_id: '1', center_code: row.code,
    center_name: row.name, status: row.status, effective_from: row.enabledAt,
    effective_to: row.disabledAt, remark: row.remark, deleted: 0,
    creator: 'fixture', create_time: '2026-10-14', updater: 'fixture',
    update_time: `db-revision-${h.dbRevision}`, future_quality_column: `future-${h.extraColumnRevision || 0}`
  })
  const sqlRel = (row, key) => ({
    id: key, tenant_id: '1', cost_center_id: row.id, dept_id: deptId,
    effective_from: row.enabledAt, effective_to: row.disabledAt, deleted: 0,
    updater: `rel-revision-${h.relationRevision}`
  })
  const tableRows = () => ({
    cost_center: [sqlCenter(h.first), sqlCenter(h.active), ...(h.inserted ? [sqlCenter(h.inserted)] : [])],
    cost_center_dept_rel: [sqlRel(h.first, '51'),
      { ...sqlRel(h.active, '52'), deleted: h.uiSaved ? 1 : 0 },
      ...(h.uiSaved ? [{ ...sqlRel(h.active, '54'), dept_id: h.uiRelationDrift ? '123' : deptId }] : []),
      ...(h.softDeletedRelation ? [{ ...sqlRel(h.active, '53'), deleted: 1 }] : [])],
    system_dept: [{ id: deptId, tenant_id: '1', code: h.department.name, name: h.department.name, status: '0', deleted: 0 }]
  })
  h.dependencies = {
    config: clone(settings), writeFixtures: true,
    async assertLocalWriteSafety () { h.safety = (h.safety || 0) + 1 },
    async runReadOnlySql (sql) {
      h.sql.push(sql)
      assert.doesNotMatch(sql, /\b(?:UPDATE|INSERT|DELETE|REPLACE|CALL)\s/i)
      if (opts.dbUnavailable || opts.dbAfterRejection && h.requestCount) return { available: false, rows: [] }
      if (sql.includes('information_schema.COLUMNS')) {
        const hex = sql.match(/TABLE_NAME=CONVERT\(0x([a-f0-9]+)/)[1]
        const table = Buffer.from(hex, 'hex').toString()
        const fields = Object.keys(tableRows()[table][0])
        return { available: true, rows: fields.map((field) => [field, field === 'deleted' ? 'bit' : 'varchar']) }
      }
      assert.match(sql, /tenant_id=1/)
      for (const [table, rows] of Object.entries(tableRows())) {
        if (sql.includes(`FROM \`${table}\``)) {
          assert.match(sql, /SELECT JSON_OBJECT/)
          if (opts.emptyFacts && table === 'cost_center') return { available: true, rows: [] }
          const selected = table === 'cost_center_dept_rel' && sql.includes(`(cost_center_id=${centerId})`)
            ? rows.filter((row) => row.cost_center_id === centerId) : rows
          return { available: true, rows: selected.map((row) => [JSON.stringify(row)]) }
        }
      }
      if (sql.includes('FROM system_role')) {
        if (/SELECT id FROM/.test(sql)) {
          const hex = sql.match(/code=CONVERT\(0x([a-f0-9]+)/)[1]
          const code = Buffer.from(hex, 'hex').toString()
          return { available: true, rows: [...h.roles.values()].filter((row) => row.code === code).map((row) => [row.id]) }
        }
        const key = sql.match(/\bid=(\d+)/)[1]
        const row = h.roles.get(key)
        assert.match(sql, /JSON_UNQUOTE\(JSON_EXTRACT\(data_scope_dept_ids,'\$\[0\]'\)\)/)
        return { available: true, rows: [[row.id, row.code, row.remark, opts.sqlScopeDrift ? '5' : '2',
          String(row.dataScopeDeptIds.length), row.dataScopeDeptIds[0], String(row.status), '2', '0', '1']] }
      }
      if (sql.includes('FROM system_users')) {
        const hex = sql.match(/username=CONVERT\(0x([a-f0-9]+)/)[1]
        const username = Buffer.from(hex, 'hex').toString()
        return { available: true, rows: [...h.users.values()].filter((row) => row.username === username).map((row) => [row.id]) }
      }
      if (sql.includes('system_oauth2_access_token')) {
        const userId = sql.match(/user_id=(\d+)/)[1]
        const remaining = opts.sessionsRemain ? '1' : String(h.sessions.get(userId) || 0)
        return { available: true, rows: [['access', remaining], ['refresh', remaining]] }
      }
      throw new Error(`unexpected SQL ${sql}`)
    },
    observePage (page, audit) {
      page.audit = audit
      return {
        async flushResponses () {
          if (opts.pageApiFailure) audit.failedApiResponses.push({ status: 200, code: 403 })
        }
      }
    },
    async loginWithCredentials (page, credentials, options) {
      assert.equal(page.url(), 'about:blank')
      assert.equal(options.returnContext, true)
      assert.equal(options.dumpDir, undefined)
      const user = [...h.users.values()].find((row) => row.username === credentials.username)
      page.key = credentials.username.startsWith('e2eccm') ? 'maintenance' : 'readOnly'
      h.logins.push({ userId: user.id, page, password: credentials.password })
      h.sessions.set(user.id, 1)
      page.currentUrl = 'http://127.0.0.1:9151/index'
      const token = `sensitive-${user.id}`
      if (opts.loginFailure) throw new Error(`password=${credentials.password}; login failed`)
      return { token, tenantId: opts.loginTenantMismatch ? '2' : '1' }
    },
    createApiClient ({ token }) {
      const userId = token.replace('sensitive-', '')
      const user = h.users.get(userId)
      const role = h.roles.get(h.bindings.get(userId)[0])
      const roleMenus = h.grants.get(role.id)
      return {
        async getBusiness (path) {
          if (path === '/system/auth/get-permission-info') {
            const granted = h.menuRows.filter((row) => roleMenus.includes(row.id) && row.permission)
              .map((row) => row.permission)
            return ok({ user: { id: userId, username: user.username, tenantId: '1', deptId },
              roles: opts.superRole ? ['super_admin'] : [role.code],
              permissions: opts.extraPermission ? [...granted, '*:*:*'] : granted,
              menus: opts.actorMenuMissing ? [] : [{ id: '1', children: [{ id: '2', children: [{ id: '3' }] }] }] })
          }
          if (path === '/cost/centers?accountingOrgId=1') return ok([detail()])
          if (path === `/cost/centers/${centerId}`) return ok(detail())
          if (path === '/cost/centers/departments') return ok(opts.actorDeptNull ? [] : [{ ...clone(h.deptRow), code: deptId }])
          throw new Error(`unexpected actor GET ${path}`)
        },
        async request (method, path, body, options) {
          recordCall(method, path, body)
          h.requestCount = (h.requestCount || 0) + 1
          assert.deepEqual(options.expectedBusinessRejection,
            { code: 403, message: '没有该操作权限', allowServiceCode: true })
          if (opts.mutateApi) h.apiRevision++
          if (opts.mutateSql) h.dbRevision++
          if (opts.extraColumnChanged) h.extraColumnRevision = (h.extraColumnRevision || 0) + 1
          if (opts.mutateAt === h.requestCount) h.dbRevision++
          if (opts.mutateRelation) h.relationRevision++
          if (opts.softDeletedRelation) h.softDeletedRelation = true
          if (opts.createPersisted) h.inserted = { ...h.active, id: '55', code: body.code }
          if (opts.transportError) throw new Error('HTTP 403 transport rejected')
          return clone(opts.denial || { code: 403, msg: '没有该操作权限', data: null })
        },
        async postBusiness (path) {
          assert.equal(path, '/system/auth/logout')
          if (opts.logoutFailure) return ok(false)
          h.sessions.set(userId, 0)
          return ok(true)
        }
      }
    },
    async openRoute (page, route) {
      assert.equal(h.foregroundPage, page, 'actor is foreground before navigation')
      page.currentUrl = `${settings.webBase}${route}`
    },
    async saveScreenshot (page, outputDir, name) {
      assert.equal(h.foregroundPage, page, 'actor is foreground before screenshot')
      h.screenshots.push({ key: page.key, name })
      h.foregroundPage = null
      return opts.screenshotMissing ? undefined : `${outputDir}/${name}.png`
    }
  }
  h.prepare = async () => {
    h.preflight = await preflightCostCenterPermissionClosure({
      api: h.api, record: h.record, caseRecord: h.caseRecord, dependencies: h.dependencies
    })
    h.active.remark = h.preflight.marker
    h.first.remark = h.preflight.marker
    return h.preflight
  }
  h.run = async (overrides = {}) => {
    if (!h.preflight) await h.prepare()
    return runCostCenterPermissionClosure({
      preflight: h.preflight, api: h.api, record: h.record, caseRecord: h.caseRecord,
      page: h.adminPage, department: h.department, activeCenter: clone(h.active),
      ownedCenters: [clone(h.first), clone(h.active)], outputDir: '/tmp/unit-only',
      dependencies: h.dependencies, ...overrides
    })
  }
  return h
}

test('formal menu intersection matches normalized ancestors without granting extra permissions', () => {
  const rows = menus()
  const plans = resolveCostCenterPermissionMenus(rows, rows)
  assert.deepEqual(plans.readOnly.permissions, permissions.slice(0, 2))
  assert.deepEqual(plans.maintenance.permissions, permissions)
  assert.ok(plans.readOnly.menuIds.includes('4'), 'backend-normalized hidden ancestry retained')
  assert.equal(plans.readOnly.menuIds.includes('12'), false)
  const queryPage = rows.find((row) => row.id === '3')
  queryPage.component = 'cost-management/section/index.vue'
  queryPage.query = '{"page":"profile"}'
  assert.deepEqual(resolveCostCenterPermissionMenus(rows, rows), plans)
  rows.push({
    id: '98', parentId: '4', status: 0, type: 2, path: 'profile',
    component: 'cost-management/section/index.vue?page=profile'
  })
  assert.deepEqual(resolveCostCenterPermissionMenus(rows, rows), plans,
    'the legacy parent chain must not make the real profile page ambiguous')
})

for (const [label, modify] of [
  ['missing permission', (rows) => rows.splice(rows.findIndex((row) => row.permission === 'cost:center:deactivate'), 1)],
  ['disabled ancestry', (rows) => { rows[0].status = 1 }],
  ['extra ancestor permission', (rows) => { rows[3].permission = 'unrelated:write' }],
  ['wildcard ancestry', (rows) => { rows[0].permission = '*:*:*' }],
  ['legacy formal page', (rows) => { rows[1].path = '/__legacy__/modeling' }],
  ['page missing', (rows) => { rows[2].component = 'different' }],
  ['ambiguous page', (rows) => rows.push({ ...rows[2], id: '99' })],
  ['ambiguous button', (rows) => rows.push({ ...rows[4], id: '99' })],
  ['cycle', (rows) => { rows[0].parentId = '2' }],
  ['deleted page', (rows) => { rows[2].deleted = true }],
  ['lossy ID', (rows) => { rows[0].id = Number.MAX_SAFE_INTEGER + 2 }]
]) {
  test(`preflight refuses ${label} without menu/package writes`, () => {
    const rows = menus()
    modify(rows)
    assert.throws(() => resolveCostCenterPermissionMenus(rows, rows), /COST-029/)
  })
}

for (const [label, modify] of [
  ['remote target', (h) => { h.dependencies.config.target = 'prod' }],
  ['tenant mismatch', (h) => { h.record.environment.tenantId = '2' }],
  ['wrong port', (h) => { h.dependencies.config.apiBase = 'http://127.0.0.1:48080' }],
  ['write flag off', (h) => { h.dependencies.writeFixtures = false }],
  ['wrong case', (h) => { h.caseRecord.id = 'COST-030' }]
]) {
  test(`preflight fails strictly for ${label} before any request`, async () => {
    const h = harness()
    modify(h)
    await assert.rejects(h.prepare, /COST-029/)
    assert.equal(h.calls.length, 0)
    assert.equal(h.caseRecord.checks.at(-1).passed, false)
  })
}

for (const opts of [{ operatorMissing: true }, { packageMissing: true }]) {
  test(`operator/menu preflight is read-only and fails closed ${JSON.stringify(opts)}`, async () => {
    const h = harness(opts)
    await assert.rejects(h.prepare, /COST-029/)
    assert.ok(h.calls.every((call) => call.method === 'GET'))
    assert.equal(h.caseRecord.checks.at(-1).passed, false)
  })
}

test('full closure uses lossless IDs, one isolated login each, real DOM open/cancel/refresh and 403 snapshots', async () => {
  const h = harness()
  await h.run()
  const evidence = h.caseRecord.costCenterPermissionClosure
  assert.equal(hasCostCenterPermissionEvidence(h.caseRecord), true)
  assert.equal(evidence.complete, true)
  assert.equal(evidence.status, 'VERIFIED')
  assert.equal(h.logins.length, 2)
  assert.notEqual(h.logins[0].page.context(), h.logins[1].page.context())
  assert.equal(h.adminPage.url(), 'http://127.0.0.1:9151/admin-original')
  assert.ok(h.contexts.every((context) => context.closed))
  assert.deepEqual(h.contexts.map((context) => context.page.reloaded), [2, 1])
  assert.deepEqual(h.contexts.map((context) => context.page.focusCount), [12, 4])
  assert.equal(evidence.uiSave.verified, true)
  assert.deepEqual(evidence.uiSave.departmentIds, [deptId])
  assert.equal(evidence.uiSave.oldRelationId, '52')
  assert.equal(evidence.uiSave.activeRelationId, '54')
  assert.equal(h.clicks.filter(([key, label]) => key === 'maintenance' && label === '取消').length, 6)
  assert.deepEqual(evidence.denials.map((entry) => entry.key), ['create', 'update', 'deactivate'])
  assert.ok(evidence.denials.every((entry) => entry.rejected && entry.unchanged &&
    entry.before.apiHash === entry.after.apiHash && entry.before.sqlHash === entry.after.sqlHash))
  assert.ok(h.sql.filter((sql) => sql.includes('JSON_OBJECT')).every((sql) =>
    !sql.includes("deleted=b'0'") && sql.includes('CAST(`deleted` AS UNSIGNED)')))
  const assignments = h.calls.filter((call) => call.path === '/system/permission/assign-role-data-scope')
  assert.ok(assignments.every((call) => call.body.dataScope === 2 &&
    assert.deepEqual(call.body.dataScopeDeptIds, [deptId]) === undefined))
  for (const call of h.calls.filter((call) => call.path.startsWith('/cost/') && call.method !== 'GET')) {
    if (call.body.departmentIds) assert.deepEqual(call.body.departmentIds, [deptId])
  }
  assert.ok(evidence.actors.every((actor) => actor.cleanup.logout && actor.cleanup.sessionsCleared &&
    actor.cleanup.userDisabled && actor.cleanup.roleDisabled && actor.cleanup.contextClosed))
  assert.ok([...h.roles.values()].every((row) => row.status === 1))
  assert.ok([...h.users.values()].every((row) => row.status === 1))
  assert.ok(h.caseRecord.checks.every((row) => row.passed))
  assert.deepEqual(h.caseRecord.checks.map((row) => row.name), Object.values(COST_CENTER_PERMISSION_CHECKS))
  assert.doesNotMatch(JSON.stringify(h.caseRecord), /Cc!|sensitive-/)
})

test('catalog fifth assertion requires private completed closure, not admin/name-only true checks', async () => {
  const names = Object.values(costCatalogBindings['COST-029']).flat()
  const fake = { checks: names.map((name) => ({ name, passed: true })), notes: [],
    costCenterPermissionClosure: { complete: true, status: 'VERIFIED' } }
  costCatalogEvidence('COST-029', fake)
  assert.equal(fake.catalogAssertions[4].status, 'GAP')
  assert.equal(fake.passCandidate, false)
  const h = harness()
  await h.run()
  h.caseRecord.checks.push(...Object.values(costCatalogBindings['COST-029']).slice(0, 4).flat()
    .map((name) => ({ name, passed: true })))
  costCatalogEvidence('COST-029', h.caseRecord)
  assert.equal(h.caseRecord.catalogAssertions[4].status, 'VERIFIED')
  assert.equal(h.caseRecord.passCandidate, true)
  h.caseRecord.checks.push({ name: COST_CENTER_PERMISSION_CHECKS.maintenance, passed: true })
  costCatalogEvidence('COST-029', h.caseRecord)
  assert.equal(h.caseRecord.passCandidate, false)
})

test('private preflight scope rejects forged/cross-run/reused handles', async () => {
  const h = harness()
  await h.prepare()
  await assert.rejects(() => h.run({ preflight: { marker: h.preflight.marker } }), /private nonce/)
  await assert.rejects(() => h.run({ record: { ...h.record } }), /private nonce/)
  await h.run()
  await assert.rejects(() => h.run(), /private nonce/)
  assert.equal(hasCostCenterPermissionEvidence(h.caseRecord), false)
})

test('mutating the original record run ID cannot reuse a privately prepared nonce', async () => {
  const h = harness()
  await h.prepare()
  h.record.runId = 'other-run'
  await assert.rejects(h.run, /private nonce\/run marker drift/)
  assert.equal(h.calls.some((call) => call.path === '/system/role/create'), false)
  assert.equal(hasCostCenterPermissionEvidence(h.caseRecord), false)
})

for (const [label, modify] of [
  ['copied department registration', (h) => ({ department: { ...h.department } })],
  ['wrong marker', (h) => { h.caseRecord.costCenterPermissionClosure.marker = 'FOREIGN'; return {} }],
  ['foreign nonce center', (h) => ({ activeCenter: { ...h.active, remark: 'FOREIGN' },
    ownedCenters: [h.first, { ...h.active, remark: 'FOREIGN' }] })],
  ['lossy center ID', (h) => ({ activeCenter: { ...h.active, id: Number(centerId) } })],
  ['disabled center', (h) => { h.active.status = 'DISABLED'; return {} }],
  ['referenced center', (h) => { h.active.referenceCount = 1; return {} }],
  ['foreign department', (h) => { h.active.departmentIds = ['123']; return {} }]
]) {
  test(`ownership refuses ${label} before provisioning`, async () => {
    const h = harness()
    await h.prepare()
    await assert.rejects(() => h.run(modify(h)), /COST-029/)
    assert.equal(h.calls.some((call) => call.path === '/system/role/create'), false)
    assert.equal(h.caseRecord.costCenterPermissionClosure.status, 'FAILED')
    assert.equal(hasCostCenterPermissionEvidence(h.caseRecord), false)
  })
}

for (const opts of [
  { adminDeptNull: true }, { emptyFacts: true }, { dbUnavailable: true },
  { customRejected: true }, { roleScopeDrift: true }, { sqlScopeDrift: true },
  { extraRoleMenu: true }, { roleIdentityDrift: true }
]) {
  test(`SELF/CUSTOM/SQL identity failure stops before user assignment ${JSON.stringify(opts)}`, async () => {
    const h = harness(opts)
    await assert.rejects(h.run, /COST-029/)
    assert.equal(h.calls.some((call) => call.path === '/system/permission/assign-user-role'), false)
    assert.equal(h.caseRecord.costCenterPermissionClosure.status, 'FAILED')
    assert.equal(h.caseRecord.costCenterPermissionClosure.complete, false)
    assert.ok(h.caseRecord.checks.some((row) => row.passed === false))
    assert.ok(!h.calls.some((call) => call.body?.dataScope === 1))
  })
}

for (const opts of [
  { lossyUiId: true }, { foreignUiCenter: true },
  { uiRelationDrift: true }, { uiDepartmentDrift: true }, { uiDepartmentNameMissing: true }
]) {
  test(`UI save guards owned payload and validates relation replacement ${JSON.stringify(opts)}`, async () => {
    const h = harness(opts)
    await assert.rejects(h.run, /COST-029/)
    assert.equal(hasCostCenterPermissionEvidence(h.caseRecord), false)
    assert.equal(h.caseRecord.costCenterPermissionClosure.uiSave, undefined)
    assert.ok(h.contexts.every((context) => context.closed && context.page.routeHandler == null))
    if (opts.lossyUiId || opts.foreignUiCenter) assert.equal(h.uiSaved, undefined)
    assert.ok(h.caseRecord.checks.some((row) => row.passed === false))
  })
}

for (const opts of [
  { extraUserRole: true }, { extraPermission: true }, { superRole: true },
  { actorMenuMissing: true }, { actorDeptNull: true }, { loginTenantMismatch: true },
  { sharedAdminContext: true },
  { domFailure: true }, { domDisabled: true }, { readerButtonPresent: true },
  { codeEditable: true }, { wrongEditorCode: true }, { pageApiFailure: true },
  { buttonDisabled: true }, { pageWrite: true }, { screenshotMissing: true }, { focusFailure: true }
]) {
  test(`actual permission/DOM/API error cannot silently become GAP ${JSON.stringify(opts)}`, async () => {
    const h = harness(opts)
    await assert.rejects(h.run, /COST-029/)
    assert.equal(hasCostCenterPermissionEvidence(h.caseRecord), false)
    assert.ok(h.caseRecord.checks.some((row) => row.passed === false))
    assert.equal(h.caseRecord.costCenterPermissionClosure.status, 'FAILED')
    assert.equal(h.calls.some((call) => call.path === `/cost/centers/${centerId}/deactivate`), false)
    assert.ok(h.contexts.every((context) => context.closed))
  })
}

for (const denial of [
  { code: 0, data: {} }, { code: 200, success: true }, { code: 401, msg: '账号未登录' },
  { code: 403, msg: 'other rejection' }, { code: 403, msg: '没有该操作权限', message: 'other' },
  { code: 403, msg: '没有该操作权限', data: { id: '9' } },
  { code: 422001, msg: '部门已归属' }, { code: 500, msg: '系统异常' }
]) {
  test(`negative evidence only accepts exact permission rejection ${JSON.stringify(denial)}`, async () => {
    const h = harness({ denial })
    await assert.rejects(h.run, /COST-029/)
    assert.equal(h.caseRecord.costCenterPermissionClosure.denials[0].rejected, false)
    assert.equal(h.caseRecord.costCenterPermissionClosure.complete, false)
    assert.ok(h.contexts.every((context) => context.closed))
  })
}

for (const opts of [
  { mutateApi: true }, { mutateSql: true }, { mutateRelation: true }, { extraColumnChanged: true },
  { softDeletedRelation: true }, { createPersisted: true }, { transportError: true }
]) {
  test(`every negative checks full-field API/SQL state, including deleted relations ${JSON.stringify(opts)}`, async () => {
    const h = harness(opts)
    await assert.rejects(h.run, /COST-029/)
    assert.equal(h.caseRecord.costCenterPermissionClosure.complete, false)
    assert.ok(h.caseRecord.checks.some((row) => row.passed === false))
    assert.ok([...h.users.values()].every((row) => row.status === 1))
    const denial = h.caseRecord.costCenterPermissionClosure.denials[0]
    assert.ok(denial.before.apiHash && denial.before.sqlHash)
    assert.ok(denial.after.apiHash && denial.after.sqlHash)
    assert.equal(denial.unchanged, opts.transportError === true)
  })
}

for (const opts of [
  { logoutFailure: true }, { sessionsRemain: true }, { disableUserFailure: true },
  { disableRoleFailure: true }, { closeFailure: true }, { loginFailure: true }, { userDrift: true }
]) {
  test(`finally failures retain exact residuals and attempt other steps ${JSON.stringify(opts)}`, async () => {
    const h = harness(opts)
    await assert.rejects(h.run, /COST-029/)
    assert.equal(h.caseRecord.costCenterPermissionClosure.complete, false)
    assert.ok(h.caseRecord.costCenterPermissionClosure.residuals.length > 0)
    assert.ok(h.calls.some((call) => call.path === '/system/role/update'))
    assert.ok(h.contexts.every((context) => context.closed))
    assert.equal(h.caseRecord.checks.find((row) => row.name === COST_CENTER_PERMISSION_CHECKS.cleanup).passed, false)
    assert.doesNotMatch(JSON.stringify(h.caseRecord), /Cc!|sensitive-/)
  })
}

test('partial provisioning failures disable owned role and redact echoed passwords in report/error', async () => {
  const h = harness({ userCreateFailure: true })
  await assert.rejects(h.run, (error) => {
    assert.ok(!error.message.includes(h.secret))
    return true
  })
  assert.ok([...h.roles.values()].every((row) => row.status === 1))
  assert.ok(!JSON.stringify(h.record).includes(h.secret))
  assert.ok(!JSON.stringify(h.caseRecord).includes(h.secret))
  assert.equal(h.caseRecord.costCenterPermissionClosure.actors[0].userCreateAbsent, true)
})

for (const mutateAt of [2, 3]) {
  test(`later rejection ${mutateAt} has its own snapshots and cannot inherit the first passing denial`, async () => {
    const h = harness({ mutateAt })
    await assert.rejects(h.run, /COST-029/)
    const denials = h.caseRecord.costCenterPermissionClosure.denials
    assert.equal(denials.length, mutateAt)
    assert.ok(denials.slice(0, -1).every((entry) => entry.rejected && entry.unchanged))
    assert.notEqual(denials.at(-1).before.sqlHash, denials.at(-1).after.sqlHash)
    assert.equal(denials.at(-1).unchanged, false)
  })
}

test('unavailable post-rejection SQL is a failed readback with explicit evidence, never empty success', async () => {
  const h = harness({ dbAfterRejection: true })
  await assert.rejects(h.run, /COST-029/)
  const denial = h.caseRecord.costCenterPermissionClosure.denials[0]
  assert.equal(denial.rejected, true)
  assert.equal(denial.unchanged, false)
  assert.equal(denial.after, null)
  assert.match(denial.readbackFailure, /READONLY SQL unavailable/)
})

test('lossy create response is a strict failure and exact SQL-owned role is resolved only for disabling', async () => {
  const h = harness({ lossyRoleId: true })
  await assert.rejects(h.run, /lossless ID/)
  assert.ok([...h.roles.values()].every((row) => row.status === 1))
  assert.equal(h.calls.some((call) => call.path === '/system/permission/assign-role-data-scope'), false)
  assert.equal(h.calls.some((call) => call.path === '/system/permission/assign-user-role'), false)
  assert.equal(h.caseRecord.costCenterPermissionClosure.actors[0].cleanup.roleCreateResolved, true)
})

test('suite wires only COST-029 fifth assertion and helper precedes existing center cleanup', () => {
  const source = fs.readFileSync(new URL('../suites/cost.mjs', import.meta.url), 'utf8')
  const branch = source.slice(source.indexOf("if (caseId === 'COST-029')"), source.indexOf("if (caseId === 'COST-030')"))
  assert.ok(branch.indexOf('preflightCostCenterPermissionClosure(') < branch.indexOf('prepareDedicatedCostDepartment('))
  assert.ok(branch.indexOf('runCostCenterPermissionClosure(') < branch.indexOf('} finally {'))
  assert.match(branch, /activeCenter: responseData\(secondCreate\)/)
  assert.match(branch, /department: dedicatedDepartment/)
  assert.match(branch, /ownedCenters: \[responseData\(firstCreate\), responseData\(secondCreate\)\]/)
  assert.match(branch, /remark: permissionPreflight.marker/)
  assert.match(branch, /isCostFixtureId\(responseData\(firstCreate\)\?\.id\)/)
  assert.match(branch, /isCostFixtureId\(responseData\(secondCreate\)\?\.id\)/)
  assert.equal((branch.match(/reason: permissionPreflight.marker/g) || []).length, 3,
    'deactivate mapper overwrites remark; retain the exact nonce through existing-chain/cleanup')
  assert.equal(Object.keys(costCatalogBindings['COST-029']).length, 5)
  const helper = fs.readFileSync(new URL('../fixtures/cost-center-permission-closure.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(helper, /runLocalFixtureSql|\.tracing\.start|\.fulfill\(|launchBrowser\(|loginAs\(/)
  assert.match(helper, /dataScope: 2/)
  assert.doesNotMatch(helper, /dataScope: 1|dataScope: 5|visit-tenant-id|tenant-package\/update/)
})

test('injected full COST-029 suite preserves nonce through formal deactivate mapper semantics and cleanup', async () => {
  const h = harness()
  const get = h.api.getBusiness
  const post = h.api.postBusiness
  h.api.getBusiness = async (path) => {
    if (path.startsWith('/cost/model-versions?')) return ok({ list: [], total: 0 })
    if (path === '/cost/centers?accountingOrgId=1') return ok([])
    if (path === '/cost/centers/departments') return ok([])
    if (path.startsWith('/system/dept/get') && h.deptRemoved) return ok(null)
    return get(path)
  }
  h.api.postBusiness = async (path, body) => {
    if (path === '/system/dept/create') {
      h.department.name = body.name
      Object.assign(h.deptRow, { name: body.name, code: body.code })
      h.first.departmentNames = [body.name]
      h.active.departmentNames = [body.name]
      return ok(deptId)
    }
    return post(path, body)
  }
  h.api.get = (path) => h.api.getBusiness(path)
  h.api.post = async (path, body) => {
    h.calls.push({ method: 'POST', path, body: clone(body) })
    if (path === '/cost/centers') {
      h.creates = (h.creates || 0) + 1
      if (h.creates === 2) return { code: 422001, msg: '存在已归属其他启用成本中心的部门' }
      const row = h.creates === 1 ? h.first : h.active
      Object.assign(row, clone(body), { status: 'ENABLED', disabledAt: null })
      return ok(clone(row))
    }
    const row = path.includes(firstId) ? h.first : h.active
    assert.ok(path.endsWith('/deactivate'))
    Object.assign(row, { status: 'DISABLED', disabledAt: body.disabledAt, remark: body.reason })
    return ok(clone(row))
  }
  h.api.put = async () => ({ code: 422001, msg: '成本中心编码创建后不允许修改' })
  h.api.deleteBusiness = async (path) => {
    assert.equal(path, `/system/dept/delete?id=${deptId}`)
    h.deptRemoved = true
    return ok(true)
  }
  await runCase({
    caseId: 'COST-029', page: h.adminPage, record: h.record,
    caseRecord: h.caseRecord, outputDir: '/tmp/unit-only'
  }, {
    login: async () => 'injected-admin-session',
    createApiClient: () => h.api, writeFixtures: true,
    assertLocalWriteSafety: h.dependencies.assertLocalWriteSafety,
    costCenterPermissionDependencies: h.dependencies
  })
  assert.ok(h.caseRecord.checks.every((check) => check.passed), JSON.stringify(h.caseRecord.checks))
  assert.equal(h.caseRecord.passCandidate, true)
  assert.equal(h.caseRecord.catalogAssertions[4].status, 'VERIFIED')
  assert.equal(h.active.status, 'DISABLED')
  assert.equal(h.first.status, 'DISABLED')
  assert.equal(h.first.remark, h.caseRecord.costCenterPermissionClosure.marker)
  assert.equal(h.active.remark, h.first.remark)
  assert.equal(h.deptRemoved, true)
  assert.equal(h.logins.length, 2)
})
