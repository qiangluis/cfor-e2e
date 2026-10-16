import { randomBytes } from 'node:crypto'
import { config } from '../config/index.mjs'

export async function closeProcurementReaderSession ({ browser, readerApi, reader }) {
  const errors = []
  const steps = [
    ['响应检查', () => browser?.flushResponses?.()],
    ['浏览器关闭', () => browser?.browser.close()],
    ['令牌退出', () => readerApi?.postBusiness('/system/auth/logout')],
    ['账号停用', () => reader?.deactivate()]
  ]
  for (const [label, run] of steps) {
    try {
      await run()
    } catch (error) {
      errors.push(new Error(`${label}失败：${error.message || error}`, { cause: error }))
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, errors.map((error) => error.message).join('；'))
  }
}

/**
 * Create an isolated关联账号 that only owns the given query permission (plus its
 * menu ancestry). Used to prove the ERP settings endpoints really gate write
 * actions on their `:update` permission instead of trusting the UI alone.
 */
export async function createProcurementPermissionReader (api, caseRecord, { permission, label, component }) {
  if (!permission) throw new Error('BLOCKED: 权限矩阵缺少目标查询权限编码')
  const menus = (await api.getBusiness('/system/menu/list')).data
  const query = menus.find((row) => row.permission === permission)
  if (!query) throw new Error(`BLOCKED: 当前租户缺少 ${permission} 权限菜单`)
  const pages = component ? menus.filter((row) => row.component === component) : []
  if (component && pages.length !== 1) {
    throw new Error(`BLOCKED: 权限矩阵页面菜单不唯一：${component}；未创建账号或角色`)
  }
  if (pages.some((row) => row.permission && row.permission !== permission)) {
    throw new Error(`BLOCKED: 权限矩阵页面权限与查询权限不一致：${component}；未创建账号或角色`)
  }
  const byId = new Map(menus.map((row) => [String(row.id), row]))
  const menuIds = []
  for (const target of [query, ...pages]) {
    let current = target
    const seen = new Set()
    while (current) {
      const id = String(current.id)
      if (seen.has(id)) throw new Error('BLOCKED: 权限矩阵菜单父链存在循环；未创建账号或角色')
      seen.add(id)
      if (!menuIds.includes(id)) menuIds.push(id)
      if (String(current.parentId) === '0') break
      current = byId.get(String(current.parentId))
      if (!current) throw new Error('BLOCKED: 权限矩阵菜单父链不完整；未创建账号或角色')
    }
  }
  const assignableIds = new Set(
    (await api.getBusiness('/system/menu/list-all-simple')).data.map((row) => String(row.id))
  )
  const unavailableIds = menuIds.filter((id) => !assignableIds.has(id))
  if (unavailableIds.length) {
    throw new Error(
      `BLOCKED: 当前租户套餐或启用菜单范围不含 ${permission} 只读权限：${unavailableIds.join(',')}；未创建账号或角色`
    )
  }
  const tag = randomBytes(4).toString('hex')
  const roleId = (await api.postBusiness('/system/role/create', {
    name: `AUTOTEST${label}只读${tag}`,
    code: `autotest_${label.toLowerCase().replace(/[^a-z0-9]/g, '_')}_reader_${tag}`,
    sort: 999,
    status: 0,
    remark: `${label} permission acceptance only`
  })).data
  const username = `autotest${label.toLowerCase().replace(/[^a-z0-9]/g, '')}${tag}`
  const password = `Auto!${tag.slice(-6)}Aa9`
  let userId
  try {
    await api.postBusiness('/system/permission/assign-role-menu', { roleId, menuIds })
    userId = (await api.postBusiness('/system/user/create', {
      username,
      nickname: `验收${label}只读${tag}`,
      password,
      sex: 0,
      postIds: [],
      remark: `${label} permission acceptance only`
    })).data
    await api.postBusiness('/system/permission/assign-user-role', { userId, roleIds: [roleId] })
  } catch (error) {
    try {
      if (userId) await api.putBusiness('/system/user/update-status', { id: userId, status: 1 })
      await api.deleteBusiness(`/system/role/delete?id=${roleId}`)
      caseRecord.notes.push(`权限矩阵账号准备失败，已停用创建的账号并清理本轮角色 ${roleId}`)
    } catch (cleanupError) {
      caseRecord.notes.push(`权限矩阵账号准备失败后的清理未完成：${cleanupError.message}`)
    }
    throw error
  }
  caseRecord.accounts = [...(caseRecord.accounts || []), {
    userId, username, roleId, menuIds, permission
  }]
  return {
    userId,
    username,
    roleId,
    credentials: { username, password, tenantName: config.tenantName },
    deactivate: () => api.putBusiness('/system/user/update-status', { id: userId, status: 1 })
  }
}
