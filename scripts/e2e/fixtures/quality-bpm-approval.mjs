import { randomBytes } from 'node:crypto'
import { config } from '../config/index.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { runReadOnlySql } from '../lib/db.mjs'

const roleCodes = ['apv_quality_inspector', 'apv_quality_mgr', 'apv_prod_mgr']

const roleRows = async (dependencies = {}) => {
  const readSql = dependencies.runReadOnlySql || runReadOnlySql
  const result = await readSql(
    `SELECT id, code FROM system_role WHERE tenant_id = 1 AND deleted = 0 ` +
    `AND code IN ('${roleCodes.join("','")}')`
  )
  return new Map((result.rows || []).map((row) => [String(row[1]), String(row[0])]))
}

const activeRoleUsers = async (roles, dependencies = {}) => {
  const readSql = dependencies.runReadOnlySql || runReadOnlySql
  const roleIds = [...new Set([...roles.values()])]
  if (!roleIds.length) return []
  const result = await readSql(
    `SELECT DISTINCT u.id, u.status FROM system_users u ` +
    `INNER JOIN system_user_role ur ON ur.user_id = u.id ` +
    `WHERE u.tenant_id = 1 AND u.deleted = 0 AND u.status = 0 ` +
    `AND ur.role_id IN (${roleIds.map((id) => `'${id}'`).join(',')})`
  )
  return (result.rows || [])
    .map((row) => ({ userId: String(row[0]), status: Number(row[1]) }))
    .filter((row) => /^\d+$/.test(row.userId) && row.status === 0)
}

const updateStatus = (api, userId, status) =>
  api.putBusiness('/system/user/update-status', {
    id: String(userId),
    status
  })

export async function createQualityApprovalAccounts (api, caseRecord, dependencies = {}) {
  const runtimeConfig = dependencies.config || config
  if (runtimeConfig.target !== 'local' || String(runtimeConfig.tenantId) !== '1' ||
      runtimeConfig.tenantName !== 'CFOR 标准平台') {
    throw new Error('BLOCKED: 质量 BPM 临时账号只允许本机 tenant1/CFOR 标准平台')
  }
  const roles = await roleRows(dependencies)
  const missing = roleCodes.filter((code) => !roles.has(code))
  if (missing.length) throw new Error(`BLOCKED: 质量 BPM 角色不存在：${missing.join(',')}`)
  const existingRoleUsers = await activeRoleUsers(roles, dependencies)
  const tag = randomBytes(5).toString('hex')
  const definitions = [
    {
      label: '质量审批',
      username: `autotestqapproval${tag}`,
      nickname: `质量审批验收${tag}`,
      roleIds: [roles.get('apv_quality_inspector'), roles.get('apv_quality_mgr')]
    },
    {
      label: '生产确认',
      username: `autotestqproduction${tag}`,
      nickname: `生产确认验收${tag}`,
      roleIds: [roles.get('apv_prod_mgr')]
    }
  ]
  const created = []
  const suspended = []
  const createdIds = new Set()
  const restoreSuspended = async (errors = []) => {
    for (const account of [...suspended].reverse()) {
      try {
        await updateStatus(api, account.userId, account.status)
      } catch (error) {
        errors.push(`${account.userId}: 恢复原审批账号状态失败：${error.message}`)
      }
    }
    return errors
  }
  try {
    for (const definition of definitions) {
      const password = `Qa!${tag.slice(-6)}Aa9`
      const userId = String((await api.postBusiness('/system/user/create', {
        username: definition.username,
        nickname: definition.nickname,
        password,
        sex: 0,
        postIds: [],
        remark: 'QUALITY-NG-001 temporary BPM acceptance account'
      })).data)
      await api.postBusiness('/system/permission/assign-user-role', {
        userId,
        roleIds: definition.roleIds
      })
      created.push({ ...definition, userId, password })
      createdIds.add(String(userId))
      caseRecord.accounts = [...(caseRecord.accounts || []), {
        userId, username: definition.username, roleIds: definition.roleIds
      }]
    }
    // The standard flow uses role candidates and randomly selects one assignee.
    // Temporarily isolate this run to the accounts created by the fixture.
    for (const account of existingRoleUsers) {
      if (createdIds.has(account.userId)) continue
      await updateStatus(api, account.userId, 1)
      suspended.push(account)
    }
    caseRecord.evidence = [
      ...(caseRecord.evidence || []),
      `质量 BPM 夹具临时停用 ${suspended.length} 个既有角色审批账号，流程完成后恢复原状态`
    ]
    return {
      quality: created[0],
      production: created[1],
      cleanup: async () => {
        const errors = []
        for (const account of [...created].reverse()) {
          try {
            assertBusinessSuccess(await updateStatus(api, account.userId, 1),
              `停用${account.label}临时账号`)
          } catch (error) {
            errors.push(`${account.username}: ${error.message}`)
          }
        }
        await restoreSuspended(errors)
        if (errors.length) throw new Error(errors.join('; '))
      }
    }
  } catch (error) {
    const cleanupErrors = []
    await restoreSuspended(cleanupErrors)
    for (const account of created.reverse()) {
      await updateStatus(api, account.userId, 1).catch((cleanupError) => {
        cleanupErrors.push(`${account.username}: 停用临时账号失败：${cleanupError.message}`)
      })
    }
    if (cleanupErrors.length) {
      throw new Error(`${error.message}; ${cleanupErrors.join('; ')}`)
    }
    throw error
  }
}
