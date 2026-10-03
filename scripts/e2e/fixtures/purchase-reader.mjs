import { randomBytes } from 'node:crypto'
import { config } from '../config/index.mjs'

export async function createPurchaseReader (api, caseRecord) {
  const menuResult = await api.getBusiness('/system/menu/list')
  const menus = menuResult.data
  const query = menus.find((row) => row.permission === 'erp:purchase-order-request:query')
  if (!query) throw new Error('BLOCKED: 当前租户缺少请购单查询权限菜单')
  const byId = new Map(menus.map((row) => [String(row.id), row]))
  const menuIds = []
  let current = query
  while (current && !menuIds.includes(String(current.id))) {
    menuIds.push(String(current.id))
    current = byId.get(String(current.parentId))
  }
  const assignableMenus = (await api.getBusiness('/system/menu/list-all-simple')).data
  const assignableIds = new Set(assignableMenus.map((row) => String(row.id)))
  const unavailableIds = menuIds.filter((id) => !assignableIds.has(id))
  if (unavailableIds.length) {
    throw new Error(`BLOCKED: 当前租户套餐或启用菜单范围不含请购只读权限：${unavailableIds.join(',')}；未创建账号或角色`)
  }
  const tag = randomBytes(4).toString('hex')
  const roleId = (await api.postBusiness('/system/role/create', {
    name: `AUTOTEST请购只读${tag}`, code: `autotest_proc_reader_${tag}`,
    sort: 999, status: 0, remark: 'PROC-014 permission acceptance only'
  })).data
  const username = `autotestprocreader${tag}`
  let userId
  try {
    await api.postBusiness('/system/permission/assign-role-menu', { roleId, menuIds })
    userId = (await api.postBusiness('/system/user/create', {
      username, nickname: `验收请购只读${tag}`,
      password: config.password, sex: 0, postIds: [],
      remark: 'PROC-014 permission acceptance only'
    })).data
    await api.postBusiness('/system/permission/assign-user-role', { userId, roleIds: [roleId] })
  } catch (error) {
    try {
      if (userId) await api.putBusiness('/system/user/update-status', { id: userId, status: 1 })
      await api.deleteBusiness(`/system/role/delete?id=${roleId}`)
      caseRecord.notes.push(`关联账号准备失败，已停用创建的账号并清理本轮角色 ${roleId}`)
    } catch (cleanupError) {
      caseRecord.notes.push(`关联账号准备失败后的清理未完成：${cleanupError.message}`)
    }
    throw error
  }
  caseRecord.accounts = [...(caseRecord.accounts || []), {
    userId, username, roleId, menuIds, permission: query.permission
  }]
  return {
    userId, username, roleId,
    credentials: { username, password: config.password, tenantName: config.tenantName },
    deactivate: () => api.putBusiness('/system/user/update-status', { id: userId, status: 1 })
  }
}
