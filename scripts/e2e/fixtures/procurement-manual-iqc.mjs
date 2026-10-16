import { isDeepStrictEqual } from 'node:util'
import { config } from '../config/index.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { assertLocalWriteSafety } from '../lib/db.mjs'

const dataOf = (payload) => assertBusinessSuccess(payload, '采购人工质检场景').data
const configPath = '/system/config/get?category=quality&tag=common'
const savePath = '/system/config/save?category=quality&tag=common'
const fields = ['id', 'billType', 'mbillApprovalType', 'abillApprovalType',
  'bpmType', 'isAutoExecute', 'isAutoEndExecute', 'isAutoClose']
const snapshot = (row) => Object.fromEntries(fields.map((key) => [key, row?.[key] ?? null]))
const readConfig = async (api) => {
  const row = dataOf(await api.getBusiness(configPath))
  const value = JSON.parse(row?.configData || '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('BLOCKED: 采购人工质检配置必须为 JSON 对象')
  }
  return value
}
const readPolicies = async (api, billType) => {
  const value = dataOf(await api.getBusiness(
    `/mes/basBillOptions/list?pageNo=1&pageSize=100&billType=${encodeURIComponent(billType)}`
  ))
  const rows = value?.records ?? value?.list ?? value
  if (!Array.isArray(rows)) throw new Error('采购人工质检审批策略未返回数组')
  return rows.filter((row) => row.billType === billType)
}

// Serial tenant configuration scenario; formal business writes remain in the callback.
export async function withProcurementManualIqc (api, caseRecord, run, dependencies = {}) {
  const settings = dependencies.config || config
  if (settings.target !== 'local' || String(settings.tenantId) !== '1' ||
      settings.tenantName !== 'CFOR 标准平台') {
    throw new Error('BLOCKED: 采购人工质检只允许本地标准测试租户')
  }
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
  const original = await readConfig(api)
  const definitions = [
    { billType: 'MesQualityInspection', isAutoExecute: 1 },
    { billType: 'PurReturn', isAutoExecute: 0 }
  ]
  const created = []
  let changed = false
  let failure
  let result
  try {
    for (const definition of definitions) {
      const rows = await readPolicies(api, definition.billType)
      if (rows.length > 1 || rows.some((row) =>
        String(row.mbillApprovalType) !== '1' ||
        String(row.abillApprovalType) !== '1' ||
        Number(row.isAutoExecute) !== definition.isAutoExecute
      )) {
        throw new Error(`BLOCKED: ${definition.billType} 已有策略不匹配，不覆盖共享策略`)
      }
      if (rows.length) continue
      await api.postBusiness('/mes/basBillOptions/add', {
        ...definition,
        billTypeLabel: definition.billType,
        mbillApprovalType: '1',
        abillApprovalType: '1',
        isAutoEndExecute: 1,
        isAutoClose: 0
      })
      const [row] = await readPolicies(api, definition.billType)
      if (!row?.id) throw new Error('新建人工质检审批策略未回读')
      created.push(snapshot(row))
    }
    if (original.is_auto_check !== false) {
      if (!isDeepStrictEqual(await readConfig(api), original)) {
        throw new Error('BLOCKED: 质量配置被并发修改，停止场景')
      }
      changed = true
      await api.postBusiness(savePath, {
        configData: JSON.stringify({ ...original, is_auto_check: false })
      })
    }
    if ((await readConfig(api)).is_auto_check !== false) {
      throw new Error('采购人工质检配置未生效')
    }
    caseRecord.checks.push({
      name: 'PROC-003 人工质检场景通过正式配置接口准备并回读',
      passed: true
    })
    result = await run()
  } catch (error) {
    failure = error
  } finally {
    const errors = []
    if (changed) {
      try {
        const latest = await readConfig(api)
        if (!isDeepStrictEqual(latest, { ...original, is_auto_check: false })) {
          throw new Error('质量配置并发变化，不覆盖其他操作')
        }
        await api.postBusiness(savePath, { configData: JSON.stringify(original) })
        if (!isDeepStrictEqual(await readConfig(api), original)) {
          throw new Error('质量配置恢复回读不一致')
        }
      } catch (error) { errors.push(error) }
    }
    for (const policy of created.reverse()) {
      try {
        const rows = await readPolicies(api, policy.billType)
        const current = rows.find((row) => String(row.id) === String(policy.id))
        if (!isDeepStrictEqual(snapshot(current), policy)) {
          throw new Error(`人工质检策略被并发修改：${policy.billType}`)
        }
        await api.deleteBusiness(`/mes/basBillOptions/delete?id=${encodeURIComponent(policy.id)}`)
        if ((await readPolicies(api, policy.billType)).some((row) => String(row.id) === String(policy.id))) {
          throw new Error('人工质检临时策略未清理')
        }
      } catch (error) { errors.push(error) }
    }
    caseRecord.checks.push({
      name: 'PROC-003 场景结束恢复质量配置并清除本轮临时策略',
      passed: errors.length === 0,
      details: errors.map((error) => error.message).join('; ')
    })
    if (errors.length) failure = new AggregateError([...(failure ? [failure] : []), ...errors], '采购人工质检场景恢复失败')
  }
  if (failure) throw failure
  return result
}
