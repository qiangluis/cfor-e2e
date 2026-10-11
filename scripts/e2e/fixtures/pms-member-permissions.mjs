import { isDeepStrictEqual } from 'node:util'
import { createApiClient, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { loginWithCredentials, observePage } from '../lib/browser.mjs'
import { createProcurementPermissionReader } from './procurement-permission-reader.mjs'

export const PMS_MEMBER_PERMISSIONS = Object.freeze([
  'pms:pm:project:query',
  'pms:pm:project-member:query',
  'pms:pm:project-member:update',
  'pms:pm:work-item:query',
  'pms:pm:work-item:update'
])

export const PMS_MEMBER_REJECTIONS = Object.freeze({
  privateRead: { code: 2050200000, message: '无权访问该项目' },
  write: { code: 2050200003, message: '当前项目角色无编辑权限' },
  manager: { code: 2050200001, message: '只有项目管理员可以执行该操作' },
  commentOwner: { code: 2050200035, message: '只能修改或删除自己的评论' }
})

export const isExactPmsRejection = (response, contract) =>
  response?.data == null && matchesExpectedBusinessRejection(response, contract)

export const pmsPermissionMenuIds = (menus, assignable, permissions = PMS_MEMBER_PERMISSIONS) => {
  const byId = new Map(menus.map((row) => [String(row.id), row]))
  const allowedIds = new Set(assignable.map((row) => String(row.id)))
  const ids = new Set()
  for (const permission of permissions) {
    let row = menus.find((item) => item.permission === permission && item.status === 0)
    if (!row) throw new Error(`BLOCKED: PMS 成员验证缺少启用权限 ${permission}`)
    const visited = new Set()
    while (row) {
      const id = String(row.id)
      if (!/^[1-9]\d*$/.test(id) || visited.has(id) || !allowedIds.has(id) || row.status !== 0) {
        throw new Error(`BLOCKED: PMS 成员验证权限父链不可分配 ${permission}/${id}`)
      }
      if (row.permission?.includes('*')) throw new Error('BLOCKED: PMS 验证不能授予通配权限')
      visited.add(id)
      ids.add(id)
      if (String(row.parentId) === '0') break
      row = byId.get(String(row.parentId))
      if (!row) throw new Error(`BLOCKED: PMS 成员验证权限父链缺失 ${permission}`)
    }
  }
  return [...ids]
}

const dataOf = (response) => response?.data
const rowsOf = (response) => {
  const data = dataOf(response)
  if (!Array.isArray(data)) throw new Error('PMS 成员验证列表回读不完整')
  return data
}

export async function verifyPmsMemberPermissions({
  adminApi, page, record, caseRecord, projectId, ownerId, workItemId,
  mainCommentId, defaultStatusId, processingStatusId, marker
}) {
  const project = dataOf(await adminApi.getBusiness(`/pms/pm/project/get?id=${projectId}`))
  if (project?.name !== marker || !marker.startsWith('E2E_PMS_001') || project.openStatus !== false) {
    throw new Error('BLOCKED: PMS 权限验证只允许本轮专属私有项目')
  }
  const menus = dataOf(await adminApi.getBusiness('/system/menu/list'))
  const assignable = dataOf(await adminApi.getBusiness('/system/menu/list-all-simple'))
  const menuIds = pmsPermissionMenuIds(menus, assignable)
  const checks = []
  const check = (name, passed, details) => {
    const entry = { name, passed: passed === true, details }
    checks.push(entry)
    caseRecord.checks.push(entry)
    if (!entry.passed) throw new Error(`${name}: ${details}`)
  }
  let account
  let isolated
  let capture
  const saveMembers = (level) => adminApi.putBusiness('/pms/pm/project-member/update-list', {
    projectId, members: [
      { userId: ownerId, level: 1 },
      ...(level == null ? [] : [{ userId: account.userId, level }])
    ]
  })
  const snapshot = async () => ({
    workItem: dataOf(await adminApi.getBusiness(`/pms/pm/work-item/get?id=${workItemId}`)),
    comments: rowsOf(await adminApi.getBusiness(`/pms/pm/work-item-comment/list?workItemId=${workItemId}`))
  })
  const rejection = async (api, label, method, path, body, contract) => {
    const before = await snapshot()
    const response = await api.request(method, path, body, { expectedBusinessRejection: contract })
    const after = await snapshot()
    check(label, isExactPmsRejection(response, contract) && isDeepStrictEqual(before, after),
      `code=${response?.code}, expected=${contract.code}/${contract.message}; unchanged=${isDeepStrictEqual(before, after)}`)
  }
  try {
    account = await createProcurementPermissionReader(adminApi, caseRecord, {
      permission: 'pms:pm:project:query', label: 'PMS001'
    })
    await adminApi.postBusiness('/system/permission/assign-role-menu', { roleId: account.roleId, menuIds })
    const accountEvidence = caseRecord.accounts.find((row) => String(row.userId) === String(account.userId))
    Object.assign(accountEvidence, { menuIds, permissions: [...PMS_MEMBER_PERMISSIONS] })
    isolated = await page.context().browser().newContext({ viewport: { width: 1600, height: 900 }, locale: 'zh-CN' })
    const accountPage = await isolated.newPage()
    capture = observePage(accountPage, record)
    const token = await loginWithCredentials(accountPage, account.credentials)
    const api = createApiClient({ token, record })
    const info = dataOf(await api.getBusiness('/system/auth/get-permission-info'))
    check('PMS 普通账号真实登录且权限完整，无通配权限',
      String(info?.user?.id) === String(account.userId) && info?.user?.username === account.username &&
      PMS_MEMBER_PERMISSIONS.every((permission) => info?.permissions?.includes(permission)) &&
      info.permissions.every((permission) => !permission.includes('*')) &&
      isDeepStrictEqual([...new Set(info.permissions.filter(Boolean))].sort(),
        [...PMS_MEMBER_PERMISSIONS].sort()),
      `userId=${account.userId}; roleId=${account.roleId}; permissions=${info?.permissions?.filter(Boolean).join(',')}`)

    for (const path of [`/pms/pm/project/get?id=${projectId}`, `/pms/pm/work-item/get?id=${workItemId}`]) {
      const response = await api.get(path, { expectedBusinessRejection: PMS_MEMBER_REJECTIONS.privateRead })
      check('PMS 非成员不能读取私有项目或工作项 ' + path,
        isExactPmsRejection(response, PMS_MEMBER_REJECTIONS.privateRead),
        `code=${response?.code}; expected=2050200000/无权访问该项目`)
    }
    await rejection(api, 'PMS 非成员评论被领域权限拒绝且未落库', 'POST',
      '/pms/pm/work-item-comment/create', { workItemId, content: `${marker} 非成员拒绝探针` },
      PMS_MEMBER_REJECTIONS.write)

    await saveMembers(4)
    const readOnly = dataOf(await api.getBusiness(`/pms/pm/project/get?id=${projectId}`))
    check('PMS 只读成员可读但无编辑或管理权',
      readOnly?.memberStatus === true && readOnly.writeStatus === false &&
      readOnly.ownerStatus === false && readOnly.adminStatus === false,
      `projectId=${projectId}, userId=${account.userId}`)
    await rejection(api, 'PMS 只读成员状态修改被拒绝且状态不变', 'PUT',
      '/pms/pm/work-item/update-status', { id: workItemId, statusId: defaultStatusId },
      PMS_MEMBER_REJECTIONS.write)
    await rejection(api, 'PMS 只读成员评论被拒绝且未落库', 'POST',
      '/pms/pm/work-item-comment/create', { workItemId, content: `${marker} 只读拒绝探针` },
      PMS_MEMBER_REJECTIONS.write)

    await saveMembers(3)
    const writer = dataOf(await api.getBusiness(`/pms/pm/project/get?id=${projectId}`))
    check('PMS 编辑成员有编辑权但无管理权',
      writer?.writeStatus === true && writer.memberStatus === true &&
      writer.adminStatus === false && writer.ownerStatus === false,
      `projectId=${projectId}, userId=${account.userId}`)
    for (const statusId of [defaultStatusId, processingStatusId]) {
      await api.putBusiness('/pms/pm/work-item/update-status', { id: workItemId, statusId })
      const saved = dataOf(await adminApi.getBusiness(`/pms/pm/work-item/get?id=${workItemId}`))
      check(`PMS 编辑成员状态流转真实回读 ${statusId}`, String(saved?.statusId) === String(statusId),
        `workItemId=${workItemId}, statusId=${saved?.statusId}`)
    }
    const ownCommentId = dataOf(await api.postBusiness('/pms/pm/work-item-comment/create', {
      workItemId, content: `${marker} 编辑成员评论`
    }))
    const own = rowsOf(await adminApi.getBusiness(
      `/pms/pm/work-item-comment/list?workItemId=${workItemId}`
    )).find((row) => String(row.id) === String(ownCommentId))
    check('PMS 编辑成员评论由真实用户创建并回读',
      String(own?.userId) === String(account.userId) && own.content === `${marker} 编辑成员评论`,
      `commentId=${ownCommentId}, userId=${own?.userId}`)
    await rejection(api, 'PMS 编辑成员不能修改他人评论且原文不变', 'PUT',
      '/pms/pm/work-item-comment/update', { id: mainCommentId, workItemId, content: `${marker} 越权修改` },
      PMS_MEMBER_REJECTIONS.commentOwner)
    await rejection(api, 'PMS 编辑成员不能删除他人评论且原文不变', 'DELETE',
      `/pms/pm/work-item-comment/delete?id=${mainCommentId}`, undefined, PMS_MEMBER_REJECTIONS.commentOwner)
    const beforeMembers = rowsOf(await adminApi.getBusiness(`/pms/pm/project-member/list?projectId=${projectId}`))
    const escalation = await api.put('/pms/pm/project-member/update-list', {
      projectId, members: [{ userId: ownerId, level: 1 }, { userId: account.userId, level: 2 }]
    }, { expectedBusinessRejection: PMS_MEMBER_REJECTIONS.manager })
    const afterMembers = rowsOf(await adminApi.getBusiness(`/pms/pm/project-member/list?projectId=${projectId}`))
    check('PMS 编辑成员不能自升管理员且成员权限不变',
      isExactPmsRejection(escalation, PMS_MEMBER_REJECTIONS.manager) &&
      isDeepStrictEqual(beforeMembers, afterMembers), `code=${escalation?.code}`)
    await api.putBusiness('/pms/pm/work-item-comment/update', {
      id: ownCommentId, workItemId, content: `${marker} 编辑成员更新评论`
    })
    const updated = rowsOf(await adminApi.getBusiness(
      `/pms/pm/work-item-comment/list?workItemId=${workItemId}`
    )).find((row) => String(row.id) === String(ownCommentId))
    check('PMS 编辑成员可以修改自己的评论', updated?.content === `${marker} 编辑成员更新评论`,
      `commentId=${ownCommentId}`)
    await api.deleteBusiness(`/pms/pm/work-item-comment/delete?id=${ownCommentId}`)
    const remaining = rowsOf(await adminApi.getBusiness(`/pms/pm/work-item-comment/list?workItemId=${workItemId}`))
    check('PMS 编辑成员可以删除自己的评论，主评论仍保留',
      !remaining.some((row) => String(row.id) === String(ownCommentId)) &&
      remaining.some((row) => String(row.id) === String(mainCommentId)), `commentId=${ownCommentId}`)
    return { verified: checks.every((entry) => entry.passed), checks }
  } finally {
    const errors = []
    if (account) {
      for (const [label, action] of [
        ['恢复专属项目仅拥有者成员', () => saveMembers(null)],
        ['停用普通账号', async () => {
          await account.deactivate()
          const user = dataOf(await adminApi.getBusiness(`/system/user/get?id=${account.userId}`))
          if (user?.username !== account.username || user?.status !== 1) throw new Error('账号停用回读失败')
        }],
        ['解绑普通账号角色', () => adminApi.postBusiness('/system/permission/assign-user-role', { userId: account.userId, roleIds: [] })],
        ['删除本轮专属权限角色', () => adminApi.deleteBusiness(`/system/role/delete?id=${account.roleId}`)]
      ]) {
        try { await action() } catch (error) { errors.push(`${label}: ${error.message}`) }
      }
    }
    if (isolated) {
      try { await capture?.flushResponses() } catch (error) { errors.push(`隔离上下文响应检查: ${error.message}`) }
      try { await isolated.close() } catch (error) { errors.push(`关闭隔离上下文: ${error.message}`) }
    }
    if (account) caseRecord.checks.push({
      name: 'PMS 权限夹具恢复成员、停用账号、解绑并删除角色',
      passed: errors.length === 0,
      details: errors.join('；') || `userId=${account.userId}; roleId=${account.roleId}`
    })
    if (errors.length) throw new Error(errors.join('；'))
  }
}
