import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { config } from '../config/index.mjs'
import { createApiClient } from '../lib/api.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { findMenuRouteByComponent } from '../suites/base-partner.mjs'

export const ownedInitCases = ['PB004-001', 'PB005-001', 'PB007-001', 'PB008-001', 'PB008-002']
const idPattern = /^[1-9]\d*$/
const id = (value) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Unsafe fixture ID')
  if (!idPattern.test(String(value))) throw new Error('Invalid fixture ID')
  return String(value)
}
const data = (response) => assertBusinessSuccess(response, 'owned init API').data
const ids = (values) => {
  if (!Array.isArray(values)) throw new Error('Invalid ID array')
  return values.map(id).sort()
}
const sameIds = (left, right) => JSON.stringify(ids(left)) === JSON.stringify(ids(right))

export function assertOwnedInitScope(settings = config) {
  if (settings.target !== 'local' || String(settings.tenantId) !== '1' ||
      settings.tenantName !== 'CFOR 标准平台' || settings.db?.name !== 'cfor_admin_standard') {
    throw new Error('BLOCKED: owned init requires local tenant1/CFOR 标准平台/cfor_admin_standard')
  }
  for (const [base, port] of [[settings.apiBase, '48083'], [settings.webBase, '9151']]) {
    const url = new URL(base)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.port !== port || url.username || url.password) {
      throw new Error('BLOCKED: owned init requires loopback 48083/9151')
    }
  }
}

export function ownedFact(caseRecord, name, passed, details = '') {
  caseRecord.checks.push({ name, passed: Boolean(passed), details })
  if (!passed) throw new Error(`${name}: ${details}`)
}

export function ownedCatalog(caseRecord, caseId, verified = []) {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const definition = catalog.suites.flatMap((suite) => suite.cases).find((row) => row.id === caseId)
  if (!definition) throw new Error(`Missing catalog ${caseId}`)
  caseRecord.catalogAssertions = definition.assertions.map((assertion, index) => ({
    index, assertion, status: verified.includes(index) ? 'VERIFIED' : 'GAP'
  }))
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((row) => row.status === 'GAP').map((row) => row.assertion)
  caseRecord.readyCandidate = caseRecord.remainingAssertions.length === 0 &&
    caseRecord.checks.length > 0 && caseRecord.checks.every((row) => row.passed)
}

export async function expectOwnedRejection(api, method, path, body, expectedCode, record, label) {
  const response = await api.request(method, path, body)
  ownedFact(record, label, response?.code === expectedCode,
    `${method} ${path}; code=${response?.code}; message=${String(response?.msg || '').slice(0, 160)}`)
  return response
}

export class OwnedInitFixtures {
  constructor(api, record, sql = runReadOnlySql) {
    this.api = api
    this.record = record
    this.sql = sql
    this.tag = `E2EOWN${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
    this.resources = []
  }

  async create(kind, body) {
    const path = `/system/${kind}/create`
    const resourceId = id(data(await this.api.postBusiness(path, body)))
    this.resources.push({ kind, id: resourceId, body: {
      ...body, ...(kind === 'user' ? { username: body.username || body.mobile } : {})
    } })
    this.record.fixtures = [...(this.record.fixtures || []), {
      kind, id: resourceId, tenantId: '1', owned: true,
      marker: kind === 'user' ? (body.username || body.mobile) : body.code
    }]
    return resourceId
  }

  async role(suffix, status = 1) {
    const body = { name: `${this.tag}${suffix}`, code: `${this.tag}${suffix}`, sort: 99,
      status, remark: this.tag }
    const roleId = await this.create('role', body)
    return { ...body, id: roleId }
  }

  async post() {
    const body = { name: this.tag, code: this.tag, sort: 99, status: 0, remark: this.tag }
    const postId = await this.create('post', body)
    return { ...body, id: postId }
  }

  async user(deptId, postIds, roleIds = []) {
    const password = `Q!${randomBytes(7).toString('hex')}`
    const body = {
      username: this.tag, nickname: this.tag, workNo: this.tag, deptId: id(deptId),
      postIds, roleIds, sex: 1, type: 4,
      mobile: `199${randomBytes(4).readUInt32BE().toString().padStart(8, '0').slice(-8)}`,
      password, remark: this.tag
    }
    const userId = await this.create('user', body)
    return { ...body, id: userId }
  }

  async mobileBoundUser(deptId, postIds, roleIds = []) {
    const password = `Q!${randomBytes(7).toString('hex')}`
    const mobile = `199${randomBytes(4).readUInt32BE().toString().padStart(8, '0').slice(-8)}`
    const body = {
      nickname: this.tag, workNo: this.tag, deptId: id(deptId),
      postIds, roleIds, sex: 1, type: 4, mobile, password, remark: this.tag
    }
    const userId = await this.create('user', body)
    const persisted = data(await this.api.getBusiness(`/system/user/get?id=${userId}`))
    if (persisted.username !== mobile) {
      throw new Error(`手机号未补齐稳定 username; userId=${userId}`)
    }
    body.username = persisted.username
    return { ...body, id: userId }
  }

  async query(stage, sql) {
    const result = await this.sql(sql)
    if (!result.available) throw new Error(`BLOCKED: ${result.reason}`)
    this.record.database = [...(this.record.database || []), { stage, ...result }]
    return result.rows
  }

  async trackInvitationUser(invitationId, username, userId) {
    const memberId = id(userId)
    const inviteId = id(invitationId)
    const rows = await this.query('invitation-user-ownership',
      `SELECT tenant_id,invitee_name,status,accepted_user_id FROM system_tenant_user_invitation
       WHERE deleted=0 AND tenant_id=1 AND id='${inviteId}'`)
    const user = data(await this.api.getBusiness(`/system/user/get?id=${memberId}`))
    if (rows.length !== 1 || rows[0][0] !== '1' || rows[0][1] !== this.tag ||
        rows[0][2] !== 'ACCEPTED' || rows[0][3] !== memberId ||
        user?.username !== username || user?.nickname !== this.tag) {
      throw new Error(`BLOCKED: invitation member ownership mismatch; invitationId=${inviteId}; userId=${memberId}`)
    }
    if (!this.resources.some((item) => item.kind === 'user' && item.id === memberId)) {
      this.resources.push({ kind: 'user', id: memberId, body: { username }, invitationId: inviteId })
      this.record.fixtures = [...(this.record.fixtures || []), {
        kind: 'user', id: memberId, tenantId: '1', owned: true, marker: username, invitationId: inviteId
      }]
    }
    return { ...user, id: memberId }
  }

  async settleInvitation(invitationId, username) {
    const inviteId = id(invitationId)
    const rows = await this.query('invitation-final-state',
      `SELECT tenant_id,invitee_name,status,accepted_user_id FROM system_tenant_user_invitation
       WHERE deleted=0 AND tenant_id=1 AND id='${inviteId}'`)
    if (rows.length !== 1 || rows[0][0] !== '1' || rows[0][1] !== this.tag) {
      throw new Error(`BLOCKED: invitation ownership mismatch; invitationId=${inviteId}`)
    }
    if (rows[0][2] === 'PENDING') {
      await this.api.postBusiness(`/system/tenant-user-invitation/revoke?id=${inviteId}`)
      const revoked = await this.query('invitation-revoked',
        `SELECT status FROM system_tenant_user_invitation WHERE deleted=0 AND tenant_id=1 AND id='${inviteId}'`)
      ownedFact(this.record, '待接受专属邀请正式撤销回读', revoked[0]?.[0] === 'CANCELLED',
        `invitationId=${inviteId}; ${JSON.stringify(revoked)}`)
    } else if (rows[0][2] === 'ACCEPTED') {
      await this.trackInvitationUser(inviteId, username, rows[0][3])
      this.record.notes.push(`invitationId=${inviteId}; ACCEPTED 审计记录保留；无正式删除邀请 API，成员另走正式删除。`)
    } else if (rows[0][2] !== 'CANCELLED') {
      throw new Error(`BLOCKED: unexpected invitation cleanup state ${rows[0][2]}; invitationId=${inviteId}`)
    }
  }

  async cleanup() {
    const failures = []
    // Users must be removed before referenced posts and roles.
    const resources = [...this.resources].sort((a, b) =>
      Number(b.kind === 'user') - Number(a.kind === 'user'))
    for (const resource of resources) {
      try {
        const row = data(await this.api.getBusiness(`/system/${resource.kind}/get?id=${resource.id}`))
        if (row) {
          const marker = resource.kind === 'user' ? 'username' : 'code'
          if (id(row.id) !== resource.id || row[marker] !== resource.body[marker]) {
            throw new Error('BLOCKED: fixture ownership mismatch')
          }
          if (resource.invitationId) {
            await this.trackInvitationUser(resource.invitationId, resource.body.username, resource.id)
          } else if (row.remark !== this.tag) {
            throw new Error('BLOCKED: fixture ownership mismatch')
          }
          await this.api.deleteBusiness(`/system/${resource.kind}/delete?id=${resource.id}`)
        }
        const after = data(await this.api.getBusiness(`/system/${resource.kind}/get?id=${resource.id}`))
        ownedFact(this.record, `正式删除本轮 ${resource.kind} 且回读为空`, after == null,
          `id=${resource.id}; tenantId=1`)
        const tables = {
          user: [['system_users', 'id'], ['system_user_role', 'user_id'], ['system_user_post', 'user_id']],
          role: [['system_role', 'id'], ['system_user_role', 'role_id'], ['system_role_menu', 'role_id']],
          post: [['system_post', 'id'], ['system_user_post', 'post_id']]
        }[resource.kind]
        const rows = await this.query(`cleanup-${resource.kind}-${resource.id}`,
          tables.map(([table, field]) =>
            `SELECT '${table}',COUNT(*) FROM ${table} WHERE deleted=0 AND tenant_id=1
             AND ${field}='${resource.id}'`).join('; '))
        ownedFact(this.record, `本轮 ${resource.kind} 主记录和关联表无活动残留`,
          rows.length === tables.length && tables.every(([table]) =>
            rows.some((row) => row[0] === table && row[1] === '0')),
          `id=${resource.id}; ${JSON.stringify(rows)}`)
      } catch (error) {
        failures.push(`${resource.kind}/${resource.id}: ${error.message}`)
        this.record.checks.push({ name: '专属夹具正式清理', passed: false, details: failures.at(-1) })
      }
    }
    if (failures.length) throw new Error(`BLOCKED: owned cleanup failed; ${failures.join('; ')}`)
  }
}

export async function withOwnedInitFixtures(api, record, run, sql) {
  const fixtures = new OwnedInitFixtures(api, record, sql)
  let result
  let failure
  try { result = await run(fixtures) } catch (error) { failure = error }
  try { await fixtures.cleanup() } catch (cleanup) {
    throw new Error(`${failure ? `${failure.message}; ` : ''}${cleanup.message}`)
  }
  if (failure) throw failure
  return result
}

async function route(context, api, component, readySelector) {
  const permission = data(await api.getBusiness('/system/auth/get-permission-info'))
  const resolved = findMenuRouteByComponent(permission.menus, component)
  if (!resolved) throw new Error(`BLOCKED: missing permitted menu ${component}`)
  await openRoute(context.page, resolved, { readySelector })
  return resolved
}

function flattenMenuTree(nodes, result = []) {
  for (const node of nodes || []) {
    result.push(node)
    flattenMenuTree(node.children, result)
  }
  return result
}

function menuByPermission(tree, permission) {
  const menu = flattenMenuTree(tree).find((item) =>
    item.permission === permission && Number(item.status) === 0)
  if (!menu) throw new Error(`BLOCKED: missing menu ${permission}`)
  return menu
}

function menuAncestorIds(tree, leafId) {
  const flat = flattenMenuTree(tree)
  const byId = new Map(flat.map((item) => [String(item.id), item]))
  const result = []
  let current = byId.get(String(leafId))
  while (current) {
    result.push(id(current.id))
    if (current.parentId == null || Number(current.parentId) === 0) break
    current = byId.get(String(current.parentId))
  }
  return result
}

async function isolatedIdentity(context, user, run) {
  const browserContext = await context.page.context().browser().newContext({
    viewport: { width: 1600, height: 900 }, locale: 'zh-CN'
  })
  try {
    const page = await browserContext.newPage()
    const auth = await login(page, { credentials: {
      tenantName: config.tenantName, username: user.username, password: user.password
    }, returnContext: true })
    const api = createApiClient({ token: auth.token, tenantId: '1', record: context.record })
    const permission = data(await api.getBusiness('/system/auth/get-permission-info'))
    ownedFact(context.caseRecord, '专属账号隔离登录身份和租户一致',
      String(auth.tenantId) === '1' && id(permission.user.id) === user.id &&
      permission.user.username === user.username, `userId=${user.id}; tenantId=${auth.tenantId}`)
    return await run(api, permission, page)
  } finally { await browserContext.close() }
}

async function runPosts(context, api, deptId) {
  const record = context.caseRecord
  await withOwnedInitFixtures(api, record, async (fixtures) => {
    const post = await fixtures.post()
    await route(context, api, 'system/post/index', '.el-table__header-wrapper th:has-text("岗位名称")')
    const page = data(await api.getBusiness(`/system/post/page?pageNo=1&pageSize=100&code=${post.code}`))
    ownedFact(record, '岗位页面和精确分页包含本轮岗位',
      Array.isArray(page?.list) && page.list.some((row) => String(row.id) === post.id),
      `postId=${post.id}; code=${post.code}`)
    await context.page.getByPlaceholder('请输入岗位编码', { exact: true }).fill(post.code)
    const pageResponse = context.page.waitForResponse((response) =>
      response.url().includes('/system/post/page?') &&
      new URL(response.url()).searchParams.get('code') === post.code)
    await context.page.getByRole('button', { name: '搜索', exact: true }).click()
    await pageResponse
    const postRow = context.page.locator('.el-table__body tr').filter({ hasText: post.code })
    await postRow.first().waitFor({ state: 'visible' })
    ownedFact(record, '岗位页面筛选真实专属岗位行', await postRow.count() === 1,
      `postId=${post.id}; code=${post.code}`)
    await saveScreenshot(context.page, context.outputDir, 'PB007-owned-post', context.record)
    const user = await fixtures.user(deptId, [post.id])
    const update = { ...user, password: undefined, postIds: [post.id, post.id] }
    await api.putBusiness('/system/user/update', update)
    await api.putBusiness('/system/user/update', update)
    const userRead = data(await api.getBusiness(`/system/user/get?id=${user.id}`))
    const relations = await fixtures.query('post-idempotent-relations',
      `SELECT tenant_id,user_id,post_id,COUNT(*) FROM system_user_post WHERE deleted=0
       AND tenant_id=1 AND user_id='${user.id}' GROUP BY tenant_id,user_id,post_id`)
    ownedFact(record, '重复保存同一岗位关系仅有一条租户内关系',
      sameIds(userRead.postIds, [post.id]) && relations.length === 1 &&
      relations[0][0] === '1' && relations[0][1] === user.id &&
      relations[0][2] === post.id && relations[0][3] === '1', JSON.stringify(relations))
    await expectOwnedRejection(api, 'DELETE', `/system/post/delete?id=${post.id}`, undefined,
      1002005004, record, '已分配岗位正式删除被引用保护拒绝')
    const retained = data(await api.getBusiness(`/system/post/get?id=${post.id}`))
    ownedFact(record, '被拒绝删除的岗位仍存在', retained?.code === post.code, `postId=${post.id}`)
    await expectOwnedRejection(api, 'POST', '/system/post/create',
      { ...post, id: undefined, code: `${post.code}Other` }, 1002005002, record, '租户内重复岗位名称拒绝')
    await expectOwnedRejection(api, 'POST', '/system/post/create',
      { ...post, id: undefined, name: `${post.name}Other` }, 1002005003, record, '租户内重复岗位编码拒绝')
    const rows = await fixtures.query('post-tenant-unique',
      `SELECT tenant_id,id,code,name FROM system_post WHERE deleted=0 AND tenant_id=1 AND code='${post.code}'`)
    ownedFact(record, '岗位租户归属和唯一回读', rows.length === 1 &&
      rows[0][0] === '1' && rows[0][1] === post.id, JSON.stringify(rows))
  })
  ownedCatalog(record, context.caseId, [0, 1, 2, 3])
}

async function runRoles(context, api, deptId) {
  const record = context.caseRecord
  await withOwnedInitFixtures(api, record, async (fixtures) => {
    await route(context, api, 'system/role/index', '.el-table__header-wrapper th:has-text("角色名称")')
    await context.page.getByRole('button', { name: '新增', exact: true }).click()
    const dialog = context.page.getByRole('dialog').filter({ hasText: '角色标识' })
    await dialog.waitFor({ state: 'visible' })
    const statusItem = dialog.locator('.el-form-item').filter({ hasText: '状态' })
    const statusText = await statusItem.innerText()
    ownedFact(record, '角色新增表单默认选择停用状态', /停用|禁用|关闭/.test(statusText), statusText)
    await saveScreenshot(context.page, context.outputDir, 'PB004-role-default', context.record)
    await dialog.getByRole('button', { name: /取\s*消/ }).click()
    const roleA = await fixtures.role('A')
    const roleB = await fixtures.role('B')
    const disabled = await fixtures.role('D')
    const read = data(await api.getBusiness(`/system/role/get?id=${roleA.id}`))
    const menus = data(await api.getBusiness(`/system/permission/list-role-menus?roleId=${roleA.id}`))
    const roleRows = await fixtures.query('safe-role-default',
      `SELECT tenant_id,id,status,data_scope FROM system_role WHERE deleted=0 AND tenant_id=1 AND id='${roleA.id}'`)
    ownedFact(record, '新自定义角色停用/仅本人/无菜单且租户正确',
      Number(read.status) === 1 && Number(read.dataScope) === 5 && Array.isArray(menus) &&
      menus.length === 0 && roleRows.length === 1 && roleRows[0][0] === '1', JSON.stringify(roleRows))
    const post = await fixtures.post()
    const user = await fixtures.user(deptId, [post.id])
    const initially = data(await api.getBusiness(`/system/permission/list-user-roles?userId=${user.id}`))
    ownedFact(record, '新用户不隐式分配任何固定编号默认角色',
      Array.isArray(initially) && initially.length === 0, `userId=${user.id}; roleIds=${JSON.stringify(initially)}`)
    await expectOwnedRejection(api, 'POST', '/system/permission/assign-user-role',
      { userId: user.id, roleIds: [disabled.id] }, 400, record, '停用角色不能分配给专属用户')
    for (const role of [roleA, roleB]) await api.putBusiness('/system/role/update', { ...role, status: 0 })
    const tree = data(await api.getBusiness('/system/menu/list'))
    const flatten = (nodes) => nodes.flatMap((node) => [node, ...flatten(node.children || [])])
    if (!Array.isArray(tree)) throw new Error('Invalid menu tree')
    const flat = flatten(tree)
    const permissions = ['system:post:query', 'system:role:query']
    for (const [index, role] of [roleA, roleB].entries()) {
      const menu = flat.find((row) => row.permission === permissions[index] && Number(row.status) === 0)
      if (!menu) throw new Error(`BLOCKED: missing menu ${permissions[index]}`)
      await api.postBusiness('/system/permission/assign-role-menu', { roleId: role.id, menuIds: [id(menu.id)] })
    }
    await api.postBusiness('/system/permission/assign-user-role', { userId: user.id, roleIds: [roleA.id] })
    await route(context, api, 'system/user/index',
      '.el-table__header-wrapper th:has-text("登陆账户")')
    const usernameInput = context.page.getByPlaceholder('请输入登录账户', { exact: true })
    await usernameInput.fill(user.username)
    await context.page.getByRole('button', { name: '搜索', exact: true }).click()
    const row = context.page.locator('.el-table__body tr').filter({ hasText: user.username })
    await row.getByRole('button', { name: '修改', exact: true }).click()
    const edit = context.page.getByRole('dialog').filter({ hasText: '用户工号' })
    await edit.waitFor({ state: 'visible' })
    const roleField = edit.locator('.el-form-item').filter({ hasText: '用户角色' }).locator('.el-select')
    await roleField.click()
    await context.page.locator('.el-select-dropdown:visible .el-select-dropdown__item')
      .filter({ hasText: roleB.name }).click()
    await context.page.keyboard.press('Escape')
    await saveScreenshot(context.page, context.outputDir, 'PB004-user-two-roles', context.record)
    const responsePromise = context.page.waitForResponse((response) =>
      response.url().endsWith('/system/user/update') && response.request().method() === 'PUT')
    await edit.getByRole('button', { name: /确\s*定/ }).click()
    const response = await responsePromise
    await edit.waitFor({ state: 'hidden' })
    ownedFact(record, '用户编辑页提交真实 update API', response.ok(), `HTTP=${response.status()}; userId=${user.id}`)
    const afterEdit = data(await api.getBusiness(`/system/permission/list-user-roles?userId=${user.id}`))
    const relations = await fixtures.query('user-edit-role-relations',
      `SELECT tenant_id,user_id,role_id FROM system_user_role WHERE deleted=0 AND tenant_id=1
       AND user_id='${user.id}' ORDER BY role_id`)
    ownedFact(record, '用户编辑页两角色写入真实 system_user_role',
      sameIds(afterEdit, [roleA.id, roleB.id]) && relations.length === 2 &&
      relations.every((item) => item[0] === '1' && item[1] === user.id) &&
      sameIds(relations.map((item) => item[2]), [roleA.id, roleB.id]), JSON.stringify(relations))
    const roleMenus = await fixtures.query('owned-role-menu-relations',
      `SELECT tenant_id,role_id,menu_id FROM system_role_menu WHERE deleted=0 AND tenant_id=1
       AND role_id IN ('${roleA.id}','${roleB.id}') ORDER BY role_id,menu_id`)
    ownedFact(record, '菜单授权只写入专属角色且租户正确', roleMenus.length > 0 &&
      roleMenus.every((item) => item[0] === '1' && [roleA.id, roleB.id].includes(item[1])) &&
      [roleA.id, roleB.id].every((roleId) => roleMenus.some((item) => item[1] === roleId)),
      JSON.stringify(roleMenus))
    await isolatedIdentity(context, user, async (_api, permission) => {
      ownedFact(record, '多启用角色权限按并集真实返回',
        permissions.every((value) => permission.permissions.includes(value)),
        `userId=${user.id}; checkedPermissions=${permissions.join(',')}`)
    })
    await api.putBusiness('/system/role/update', { ...roleB, status: 1 })
    await isolatedIdentity(context, user, async (_api, permission) => {
      ownedFact(record, '停用角色不再参与权限并集',
        permission.permissions.includes(permissions[0]) && !permission.permissions.includes(permissions[1]),
        `userId=${user.id}; disabledRoleId=${roleB.id}`)
    })
  })
  ownedCatalog(record, context.caseId, [0, 1, 2, 3, 4])
}

async function runPermissionBoundary(context, api, deptId) {
  const record = context.caseRecord
  await withOwnedInitFixtures(api, record, async (fixtures) => {
    await route(context, api, 'system/role/index',
      '.el-table__header-wrapper th:has-text("角色名称")')
    ownedFact(record, '角色页面可读取且提供菜单权限入口',
      await context.page.locator('.el-table__header-wrapper th')
        .filter({ hasText: '角色名称' }).isVisible() &&
      await context.page.getByRole('button', { name: '菜单权限', exact: true }).first().isVisible(),
      context.page.url())

    const tree = data(await api.getBusiness('/system/menu/list'))
    if (!Array.isArray(tree)) throw new Error('Invalid menu tree')
    const roleQuery = menuByPermission(tree, 'system:role:query')
    const postQuery = menuByPermission(tree, 'system:post:query')
    const assignRoleMenu = menuByPermission(tree, 'system:permission:assign-role-menu')
    const roleMenuIds = menuAncestorIds(tree, roleQuery.id)
    const targetRole = await fixtures.role('Target', 0)
    await context.page.getByPlaceholder('请输入角色标识', { exact: true }).fill(targetRole.code)
    const pageResponse = context.page.waitForResponse((response) =>
      response.url().includes('/system/role/page?') &&
      new URL(response.url()).searchParams.get('code') === targetRole.code)
    await context.page.getByRole('button', { name: '搜索', exact: true }).click()
    await pageResponse
    const row = context.page.locator('.el-table__body tr').filter({ hasText: targetRole.code })
    await row.waitFor({ state: 'visible' })
    await row.getByRole('button', { name: '菜单权限', exact: true }).click()
    const menuDialog = context.page.getByRole('dialog').filter({ hasText: targetRole.code })
    await menuDialog.waitFor({ state: 'visible' })
    await saveScreenshot(context.page, context.outputDir, 'PB005-owned-menu-entry', context.record)
    await menuDialog.getByRole('button', { name: /取\s*消/ }).click()
    await api.postBusiness('/system/permission/assign-role-menu', {
      roleId: targetRole.id, menuIds: [roleQuery.id]
    })
    const normalized = ids(data(await api.getBusiness(
      `/system/permission/list-role-menus?roleId=${targetRole.id}`)))
    ownedFact(record, '服务端补齐角色菜单页面和目录父链',
      sameIds(roleMenuIds, normalized),
      `roleId=${targetRole.id}; expected=${roleMenuIds.join(',')}; actual=${normalized.join(',')}`)

    const operatorRole = await fixtures.role('Operator', 0)
    await api.postBusiness('/system/permission/assign-role-menu', {
      roleId: operatorRole.id, menuIds: [assignRoleMenu.id, roleQuery.id]
    })
    const operator = await fixtures.user(deptId, [], [operatorRole.id])
    await isolatedIdentity(context, operator, async (operatorApi, permission, page) => {
      ownedFact(record, '专属普通权限管理员实际登录且拥有菜单授权入口',
        permission.permissions?.includes('system:permission:assign-role-menu') &&
        !permission.permissions.includes('system:post:query') &&
        !permission.roles.includes('super_admin') && !permission.roles.includes('tenant_admin'),
        `userId=${operator.id}; roleId=${operatorRole.id}`)
      const permittedRoute = findMenuRouteByComponent(permission.menus, 'system/role/index')
      ownedFact(record, '专属权限管理员实际用户菜单提供角色页', Boolean(permittedRoute), `userId=${operator.id}`)
      await openRoute(page, permittedRoute, {
        readySelector: '.el-table__header-wrapper th:has-text("角色名称")'
      })
      await saveScreenshot(page, context.outputDir, 'PB005-operator-role-menu', context.record)
      const forbidden = await operatorApi.request('POST', '/system/permission/assign-role-menu', {
        roleId: targetRole.id, menuIds: [postQuery.id]
      })
      ownedFact(record, '普通权限管理员不能授予自身未拥有的菜单',
        forbidden?.code === 403 && /自身未拥有/.test(String(forbidden.msg)),
        `roleId=${targetRole.id}; requestedMenuId=${postQuery.id}; code=${forbidden?.code}`)
    })
    ownedFact(record, '越权拒绝后角色授权保持原集合',
      sameIds(data(await api.getBusiness(`/system/permission/list-role-menus?roleId=${targetRole.id}`)), normalized),
      `roleId=${targetRole.id}`)

    const invalidRows = await fixtures.query('invalid-resource-preflight',
      `SELECT 'missing-menu',COUNT(*) FROM system_menu WHERE id=900000000000001;
       SELECT 'deleted-menu',id FROM system_menu WHERE deleted=1 ORDER BY id LIMIT 1;
       SELECT 'missing-dept',COUNT(*) FROM system_dept WHERE id=900000000000001`)
    ownedFact(record, '反例资源不存在且有真实已删除菜单样本',
      invalidRows.some((item) => item[0] === 'missing-menu' && item[1] === '0') &&
      invalidRows.some((item) => item[0] === 'missing-dept' && item[1] === '0') &&
      invalidRows.some((item) => item[0] === 'deleted-menu'), JSON.stringify(invalidRows))
    for (const [label, invalidId] of [
      ['不存在', '900000000000001'],
      ['已删除', id(invalidRows.find((item) => item[0] === 'deleted-menu')[1])]
    ]) {
      const invalidMenu = await api.request('POST', '/system/permission/assign-role-menu', {
        roleId: targetRole.id, menuIds: [roleQuery.id, invalidId]
      })
      ownedFact(record, `${label}菜单混合有效资源提交被整体拒绝`,
        invalidMenu?.code === 400 && /菜单|资源/.test(String(invalidMenu.msg)),
        `roleId=${targetRole.id}; invalidMenuId=${invalidId}; code=${invalidMenu?.code}`)
    }
    const unchanged = ids(data(await api.getBusiness(
      `/system/permission/list-role-menus?roleId=${targetRole.id}`)))
    ownedFact(record, '无效菜单拒绝后专属角色授权未被部分写入',
      JSON.stringify(unchanged) === JSON.stringify(normalized),
      `roleId=${targetRole.id}; before=${normalized.join(',')}; after=${unchanged.join(',')}`)

    const invalidDept = await api.request('POST', '/system/permission/assign-role-data-scope', {
      roleId: targetRole.id, dataScope: 2, dataScopeDeptIds: ['900000000000001']
    })
    ownedFact(record, '不存在部门数据范围提交被拒绝',
      invalidDept?.code === 400 && /部门/.test(String(invalidDept.msg)),
      `roleId=${targetRole.id}; code=${invalidDept?.code}`)
    const roleRead = data(await api.getBusiness(`/system/role/get?id=${targetRole.id}`))
    ownedFact(record, '无效部门拒绝后角色数据范围仍为仅本人',
      Number(roleRead.dataScope) === 5, `roleId=${targetRole.id}; dataScope=${roleRead.dataScope}`)
    await api.postBusiness('/system/permission/assign-role-data-scope', {
      roleId: targetRole.id, dataScope: 2, dataScopeDeptIds: [deptId]
    })
    const scopeRows = await fixtures.query('owned-permission-db',
      `SELECT tenant_id,role_id,menu_id FROM system_role_menu WHERE deleted=0 AND tenant_id=1 AND role_id='${targetRole.id}';
       SELECT 'scope',tenant_id,data_scope,data_scope_dept_ids FROM system_role WHERE deleted=0 AND tenant_id=1 AND id='${targetRole.id}'`)
    ownedFact(record, '授权父链和当前租户部门范围真实持久化',
      sameIds(scopeRows.filter((item) => item[0] === '1').map((item) => item[2]), normalized) &&
      scopeRows.some((item) => item[0] === 'scope' && item[1] === '1' && item[2] === '2' &&
        sameIds(JSON.parse(item[3]), [deptId])), JSON.stringify(scopeRows))
  })
  ownedCatalog(record, context.caseId, [0, 1, 2, 3, 4])
  record.notes.push('未使用跨租户部门样本，PB005-001“自定义部门数据范围仅当前租户”仍缺跨租户正反证据。')
  return { partial: true, note: record.remainingAssertions.join('; ') }
}

async function runStableUser(context, api, deptId) {
  const record = context.caseRecord
  await withOwnedInitFixtures(api, record, async (fixtures) => {
    const role = await fixtures.role('StableUser', 0)
    const post = await fixtures.post()
    const user = await fixtures.mobileBoundUser(deptId, [post.id], [role.id])
    const created = data(await api.getBusiness(`/system/user/get?id=${user.id}`))
    ownedFact(record, '手机号创建用户自动补齐稳定 username',
      created.username === user.mobile && created.mobile === user.mobile &&
      String(created.deptId) === String(deptId), `userId=${user.id}; username=${created.username}`)

    const renamed = `${fixtures.tag}Renamed`
    const ordinaryEdit = await api.request('PUT', '/system/user/update', {
      ...created, id: user.id, username: renamed, password: undefined
    })
    ownedFact(record, '普通用户编辑不可修改 username',
      ordinaryEdit?.code === 1002003012,
      `userId=${user.id}; code=${ordinaryEdit?.code}`)
    const afterRejectedEdit = data(await api.getBusiness(`/system/user/get?id=${user.id}`))
    ownedFact(record, 'username 拒绝后原稳定账号未变化',
      afterRejectedEdit.username === user.mobile, `userId=${user.id}; username=${afterRejectedEdit.username}`)

    const reboundMobile = `199${randomBytes(4).readUInt32BE().toString().padStart(8, '0').slice(-8)}`
    await isolatedIdentity(context, user, async (userApi) => {
      await userApi.putBusiness('/system/user/profile/update', {
        nickname: user.nickname, email: '', mobile: reboundMobile, sex: 1, avatar: ''
      })
    })
    const rebound = data(await api.getBusiness(`/system/user/get?id=${user.id}`))
    ownedFact(record, '专属用户自助手机号换绑成功',
      rebound.mobile === reboundMobile, `userId=${user.id}; mobileChanged=true`)
    ownedFact(record, '手机号换绑不静默重写历史 username',
      rebound.username === user.mobile, `userId=${user.id}; username=${rebound.username}`)
    const relations = await fixtures.query('stable-user-relations',
      `SELECT 'user',tenant_id,dept_id FROM system_users WHERE deleted=0 AND tenant_id=1 AND id='${user.id}';
       SELECT 'role',tenant_id,user_id,role_id FROM system_user_role WHERE deleted=0 AND tenant_id=1 AND user_id='${user.id}';
       SELECT 'post',tenant_id,user_id,post_id FROM system_user_post WHERE deleted=0 AND tenant_id=1 AND user_id='${user.id}'`)
    ownedFact(record, '角色、岗位、部门关系仍按租户关系表写入',
      relations.some((row) => row[0] === 'user' && row[1] === '1' && row[2] === String(deptId)) &&
      relations.some((row) => row[0] === 'role' && row[1] === '1' && row[2] === user.id && row[3] === role.id) &&
      relations.some((row) => row[0] === 'post' && row[1] === '1' && row[2] === user.id && row[3] === post.id),
      JSON.stringify(relations))
  })
  ownedCatalog(record, context.caseId, [0, 1, 2, 3])
  return { partial: !record.readyCandidate, note: record.remainingAssertions.join('; ') }
}

async function runInvitation(context, api, deptId) {
  const record = context.caseRecord
  await withOwnedInitFixtures(api, record, async (fixtures) => {
    const role = await fixtures.role('Invite', 0)
    const post = await fixtures.post()
    await route(context, api, 'system/user/index',
      '.el-table__header-wrapper th:has-text("登陆账户")')
    ownedFact(record, '用户管理页邀请成员入口可见',
      await context.page.getByRole('button', { name: /邀请成员/ }).isVisible(), context.page.url())
    await saveScreenshot(context.page, context.outputDir, 'PB008-invitation-entry', context.record)
    const invitationPage = data(await api.getBusiness('/system/tenant-user-invitation/page?pageNo=1&pageSize=100'))
    if (!Array.isArray(invitationPage?.list)) throw new Error('Invalid invitation page')
    record.evidence.push(`邀请分页 code=0; count=${invitationPage.list.length}; 空列表不作为隔离通过证据`)
    ownedCatalog(record, context.caseId, [0])
    // Never persist the token-bearing create response in the shared API record.
    const secretApi = createApiClient({ token: context.auth.token, tenantId: '1' })
    const createResponse = await secretApi.post('/system/tenant-user-invitation/create', {
      inviteeName: fixtures.tag, inviteeMobile: `199${randomBytes(4).readUInt32BE().toString().padStart(8, '0').slice(-8)}`,
      roleIds: [role.id], deptId, postIds: [post.id], validHours: 1
    })
    const createEvidence = {
      method: 'POST', pathname: '/system/tenant-user-invitation/create',
      code: createResponse?.code,
      bodySummary: JSON.stringify({ code: createResponse?.code, msg: createResponse?.msg,
        data: createResponse?.code === 0 ? '[invitation credential omitted]' : null })
    }
    context.record.api.push(createEvidence)
    if (createResponse?.code !== 0) {
      const rows = await fixtures.query('failed-invitation-no-fact',
        `SELECT 'invitation',COUNT(*) FROM system_tenant_user_invitation
         WHERE deleted=0 AND tenant_id=1 AND invitee_name='${fixtures.tag}'`)
      ownedFact(record, '邀请创建失败没有留下本轮邀请事实', rows[0]?.[1] === '0', JSON.stringify(rows))
    }
    const invitation = data(createResponse)
    const invitationId = id(invitation?.id)
    const invitedUsername = `${fixtures.tag}InviteUser`.slice(0, 30)
    let failure
    try {
      ownedFact(record, '创建专属待接受邀请且不触发外部短信/邮件',
        (invitation.tenantId == null || String(invitation.tenantId) === '1') &&
        new URL(invitation.invitationPath, config.webBase).searchParams.get('tenantId') === '1' &&
        invitation.inviteeName === fixtures.tag &&
        invitation.status === 'PENDING' && typeof invitation.invitationToken === 'string',
        `invitationId=${invitationId}; tenantId=1; delivery=manual link; not external delivery evidence`)
      if (invitation.tenantId == null) {
        record.notes.push('创建邀请响应 tenantId 未回填；租户归属另以邀请路径、分页及数据库回读验证。')
      }
      record.fixtures = [...(record.fixtures || []), { kind: 'invitation', id: invitationId,
        tenantId: '1', owned: true, marker: fixtures.tag }]
      const rows = await fixtures.query('owned-invitation-tenant',
        `SELECT id,tenant_id,status FROM system_tenant_user_invitation WHERE deleted=0
         AND tenant_id=1 AND id='${invitationId}'`)
      ownedFact(record, '邀请真实持久化为当前租户专属待接受记录',
        rows.length === 1 && rows[0][0] === invitationId && rows[0][1] === '1' &&
        rows[0][2] === 'PENDING', JSON.stringify(rows))
      const ownedPage = data(await api.getBusiness(
        `/system/tenant-user-invitation/page?pageNo=1&pageSize=100&keyword=${fixtures.tag}`))
      ownedFact(record, '邀请分页包含专属邀请且返回当前租户', ownedPage?.list?.length === 1 &&
        String(ownedPage.list[0].id) === invitationId &&
        String(ownedPage.list[0].tenantId) === '1', `invitationId=${invitationId}; tenantId=1`)
      const publicApi = createApiClient({ tenantId: '1' })
      const noExisting = await fixtures.query('invited-username-preflight',
        `SELECT COUNT(*) FROM system_users WHERE deleted=0 AND tenant_id=1 AND username='${invitedUsername}'`)
      ownedFact(record, '正规接受仅使用不存在的专属成员账号', noExisting[0]?.[0] === '0',
        `username=${invitedUsername}`)
      const weak = await publicApi.post('/system/tenant-user-invitation/accept', {
        token: invitation.invitationToken, username: invitedUsername,
        nickname: fixtures.tag, password: '12345678'
      })
      ownedFact(record, '邀请接受公共默认密码被正式服务拒绝',
        weak?.code === 1002003013 &&
        /密码/.test(String(weak.msg)), `code=${weak?.code}; message=${String(weak?.msg || '').slice(0, 160)}`)
      const noUser = await fixtures.query('weak-invite-no-user',
        `SELECT COUNT(*) FROM system_users WHERE deleted=0 AND tenant_id=1 AND username='${invitedUsername}'`)
      ownedFact(record, '弱密码接受失败未创建成员', noUser[0]?.[0] === '0', JSON.stringify(noUser))

      const acceptedPassword = `R!${randomBytes(7).toString('hex')}`
      const accepted = await publicApi.post('/system/tenant-user-invitation/accept', {
        token: invitation.invitationToken, username: invitedUsername,
        nickname: fixtures.tag, password: acceptedPassword
      })
      const acceptedData = data(accepted)
      const acceptedUserId = id(acceptedData.userId)
      const member = await fixtures.trackInvitationUser(invitationId, invitedUsername, acceptedUserId)
      ownedFact(record, '成员通过正规邀请入口自行设置非默认密码并加入租户',
        String(acceptedData.tenantId) === '1' &&
        acceptedData.username === invitedUsername &&
        acceptedData.userId != null, `tenantId=${acceptedData.tenantId}; userId=${acceptedUserId}`)
      const acceptedRows = await fixtures.query('accepted-invitation-user',
        `SELECT id,tenant_id,username,remark FROM system_users
         WHERE deleted=0 AND tenant_id=1 AND id='${acceptedUserId}'`)
      ownedFact(record, '接受邀请创建的成员属于本轮专属租户账号',
        acceptedRows.length === 1 && acceptedRows[0][0] === acceptedUserId &&
        acceptedRows[0][1] === '1' && acceptedRows[0][2] === invitedUsername,
        JSON.stringify(acceptedRows))
      const acceptedInvitation = await fixtures.query('accepted-invitation-state',
        `SELECT id,tenant_id,status,accepted_user_id FROM system_tenant_user_invitation
         WHERE deleted=0 AND tenant_id=1 AND id='${invitationId}'`)
      ownedFact(record, '邀请接受状态和 accepted_user_id 正确回读',
        acceptedInvitation.length === 1 && acceptedInvitation[0][0] === invitationId &&
        acceptedInvitation[0][1] === '1' && acceptedInvitation[0][2] === 'ACCEPTED' &&
        acceptedInvitation[0][3] === acceptedUserId, JSON.stringify(acceptedInvitation))
      const memberRelations = await fixtures.query('accepted-member-relations',
        `SELECT 'role',tenant_id,role_id FROM system_user_role WHERE deleted=0 AND tenant_id=1 AND user_id='${acceptedUserId}';
         SELECT 'post',tenant_id,post_id FROM system_user_post WHERE deleted=0 AND tenant_id=1 AND user_id='${acceptedUserId}'`)
      ownedFact(record, '接受后本轮角色岗位关系写入且租户一致',
        memberRelations.length === 2 &&
        memberRelations.some((item) => item[0] === 'role' && item[1] === '1' && item[2] === role.id) &&
        memberRelations.some((item) => item[0] === 'post' && item[1] === '1' && item[2] === post.id),
        JSON.stringify(memberRelations))
      await isolatedIdentity(context, { ...member, password: acceptedPassword }, async (_api, permission) => {
        ownedFact(record, '邀请成员以自行设置的密码真实登录并命中专属角色',
          permission.roles.includes(role.code), `userId=${acceptedUserId}; role=${role.code}`)
      })

      const directDefaultUsername = `${fixtures.tag}DirectDefault`.slice(0, 30)
      const directDefault = await api.request('POST', '/system/user/create', {
        username: directDefaultUsername, nickname: fixtures.tag, workNo: fixtures.tag,
        deptId, postIds: [], roleIds: [], sex: 1, type: 4,
        mobile: `199${randomBytes(4).readUInt32BE().toString().padStart(8, '0').slice(-8)}`,
        password: '12345678', remark: fixtures.tag
      })
      if (directDefault?.code === 0) {
        const unexpectedId = id(directDefault.data)
        fixtures.resources.push({ kind: 'user', id: unexpectedId, body: { username: directDefaultUsername } })
        record.fixtures.push({ kind: 'user', id: unexpectedId, tenantId: '1', owned: true, marker: directDefaultUsername })
      }
      ownedFact(record, '直接创建用户拒绝公共默认密码',
        directDefault?.code === 1002003013 && /密码/.test(String(directDefault.msg)),
        `username=${directDefaultUsername}; code=${directDefault?.code}`)
      const noDirectDefaultUser = await fixtures.query('direct-default-no-user',
        `SELECT COUNT(*) FROM system_users WHERE deleted=0 AND tenant_id=1 AND username='${directDefaultUsername}'`)
      ownedFact(record, '直接创建公共默认密码拒绝未落成员事实',
        noDirectDefaultUser[0]?.[0] === '0', JSON.stringify(noDirectDefaultUser))

      const resetUser = await fixtures.user(deptId, [], [])
      const resetDefault = await api.request('PUT', '/system/user/update-password', {
        id: resetUser.id, password: '12345678'
      })
      ownedFact(record, '管理员重置用户拒绝公共默认密码',
        resetDefault?.code === 1002003013 && /密码/.test(String(resetDefault.msg)),
        `userId=${resetUser.id}; code=${resetDefault?.code}`)
      await isolatedIdentity(context, resetUser, async () => {
        ownedFact(record, '默认密码重置拒绝后原专属密码仍可真实登录', true, `userId=${resetUser.id}`)
      })
      ownedCatalog(record, context.caseId, [0, 1, 2, 3])
    } catch (error) { failure = error }
    try { await fixtures.settleInvitation(invitationId, invitedUsername) } catch (cleanup) {
      throw new Error(`${failure?.message || ''}; invitation cleanup failed: ${cleanup.message}`)
    }
    if (failure) throw failure
  })
  ownedCatalog(record, context.caseId, [0, 1, 2, 3])
  record.notes.push('本轮使用专属手机号邀请并通过正规 WEB accept；未发送邮件、未修改任何正式成员。接受后的邀请无正式删除 API，保留为本轮可追溯事实。')
  return { partial: true, note: record.remainingAssertions.join('; ') }
}

export async function runOwnedInitCase(context, dependencies = {}) {
  assertOwnedInitScope(dependencies.config || config)
  if (!ownedInitCases.includes(context.caseId)) throw new Error('BLOCKED: unsupported owned init case')
  ownedCatalog(context.caseRecord, context.caseId)
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(context.caseRecord)
  const auth = await (dependencies.login || login)(context.page, { returnContext: true })
  const api = (dependencies.createApiClient || createApiClient)({ token: auth.token, tenantId: '1', record: context.record })
  if (String(auth.tenantId) !== '1' || String(await api.tenantIdByName(config.tenantName)) !== '1') {
    throw new Error('BLOCKED: owned init authenticated tenant mismatch')
  }
  const permission = data(await api.getBusiness('/system/auth/get-permission-info'))
  const required = ['system:role:create', 'system:role:update', 'system:role:delete',
    'system:permission:assign-role-menu', 'system:permission:assign-user-role',
    'system:post:create', 'system:post:delete']
  if (!required.every((value) => permission.permissions?.includes(value) ||
      permission.permissions?.includes('*:*:*'))) {
    throw new Error('BLOCKED: administrator lacks fixture permissions')
  }
  ownedFact(context.caseRecord, '本地租户身份与夹具管理权限前置通过', true,
    `tenantId=1; operatorUserId=${id(permission.user.id)}`)
  const depts = data(await api.getBusiness('/system/dept/list'))
  const dept = Array.isArray(depts) && depts.find((row) => Number(row.status) === 0)
  if (!dept) throw new Error('BLOCKED: no enabled tenant1 department')
  const scoped = { ...context, auth }
  if (context.caseId === 'PB004-001') return runRoles(scoped, api, id(dept.id))
  if (context.caseId === 'PB005-001') return runPermissionBoundary(scoped, api, id(dept.id))
  if (context.caseId === 'PB007-001') return runPosts(scoped, api, id(dept.id))
  if (context.caseId === 'PB008-001') return runStableUser(scoped, api, id(dept.id))
  return runInvitation(scoped, api, id(dept.id))
}
