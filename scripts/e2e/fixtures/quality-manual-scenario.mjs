import { isDeepStrictEqual } from 'node:util'
import { config } from '../config/index.mjs'
import { assertLocalDatabase, assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { dataOf, pushCheck, rowsOf } from './mes-quality-write.mjs'

const configPath = '/system/config/get?category=quality&tag=common'
const savePath = '/system/config/save?category=quality&tag=common'
const policies = [
  { billType: 'MesStkIo:201', isAutoExecute: 0 },
  { billType: 'MesQualityInspection', isAutoExecute: 1 }
]
const policyFields = [
  'billType', 'mbillApprovalType', 'abillApprovalType', 'bpmType',
  'isAutoExecute', 'isAutoEndExecute', 'isAutoClose'
]
const policySnapshot = (row) =>
  Object.fromEntries(policyFields.map((key) => [key, row[key] ?? null]))
const dictionarySnapshot = (row) => ({
  id: String(row.id),
  dictType: row.dictType,
  value: row.value,
  label: row.label,
  status: row.status,
  remark: row.remark
})
const findDictionary = async (api, billType, dependencies = {}) => {
  const sql = dependencies.runReadOnlySql || runReadOnlySql
  const snapshot = await sql(
    `SELECT id, dict_type, value, label, status, remark FROM system_dict_data ` +
    `WHERE tenant_id IN (0, 1) AND dict_type = 'bill_type' ` +
    `AND value = '${billType}' AND deleted = 0 ` +
    `ORDER BY tenant_id DESC LIMIT 1`
  )
  const row = snapshot.rows?.[0]
  if (row) {
    return {
      id: row[0], dictType: row[1], value: row[2], label: row[3],
      status: Number(row[4]), remark: row[5]
    }
  }
  const rows = rowsOf(await api.getBusiness('/system/dict-data/type?type=bill_type'))
  return rows.find((item) => item.value === billType) || null
}
const policyRows = async (api, billType) =>
  rowsOf(await api.getBusiness(
    `/mes/basBillOptions/list?pageNo=1&pageSize=100&billType=${encodeURIComponent(billType)}`
  )).filter((row) => row.billType === billType)

const readConfig = async (api) => {
  const row = dataOf(await api.getBusiness(configPath))
  const value = JSON.parse(row?.configData || '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('BLOCKED: quality common config must be a JSON object')
  }
  return value
}

export function assertManualOqcScope (settings = config) {
  if (settings.target !== 'local' || String(settings.tenantId) !== '1' ||
      settings.tenantName !== 'CFOR 标准平台') {
    throw new Error('BLOCKED: manual OQC requires local tenant1/CFOR 标准平台')
  }
  for (const [base, port] of [[settings.apiBase, '48083'], [settings.webBase, '9151']]) {
    const url = new URL(base)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.port !== port || url.username || url.password) {
      throw new Error('BLOCKED: manual OQC requires loopback 48083/9151')
    }
  }
  assertLocalDatabase(settings.db)
}

// This scenario is serialized: it temporarily changes tenant-level settings.
export async function withManualOqcScenario (api, caseRecord, run, dependencies = {}) {
  assertManualOqcScope(dependencies.config || config)
  if (String(await api.tenantIdByName('CFOR 标准平台')) !== '1') {
    throw new Error('BLOCKED: manual OQC live tenant does not match tenant1')
  }
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
  const original = await readConfig(api)
  const preflight = []
  for (const policy of policies) {
    const rows = await policyRows(api, policy.billType)
    if (rows.length > 1 || rows.some((row) =>
      String(row.mbillApprovalType) !== '1' ||
      String(row.abillApprovalType) !== '1' ||
      Number(row.isAutoExecute) !== policy.isAutoExecute ||
      (policy.isAutoExecute === 1 && Number(row.isAutoEndExecute) !== 1)
    )) {
      throw new Error(`BLOCKED: existing ${policy.billType} policy differs; do not overwrite it`)
    }
    const dictionaryRow = await findDictionary(api, policy.billType, dependencies)
    preflight.push({ ...policy, existing: rows[0], dictionaryRow })
  }
  const created = []
  const createdDictionaries = []
  let configChanged = false
  let result
  let failure
  try {
    for (const policy of preflight) {
      if (policy.existing) continue
      await api.postBusiness('/mes/basBillOptions/add', {
        billType: policy.billType,
        billTypeLabel: policy.dictionaryRow?.label || policy.billType,
        mbillApprovalType: '1',
        abillApprovalType: '1',
        isAutoExecute: policy.isAutoExecute,
        isAutoEndExecute: 1,
        isAutoClose: 0
      })
      const [row] = await policyRows(api, policy.billType)
      if (!row?.id) throw new Error(`Created OQC policy did not return an ID: ${policy.billType}`)
      created.push({ id: String(row.id), snapshot: policySnapshot(row) })
      if (!policy.dictionaryRow) {
        const createdDictionary = await findDictionary(api, policy.billType, dependencies)
        if (!createdDictionary?.id) {
          throw new Error(`Created OQC policy did not create bill_type dictionary: ${policy.billType}`)
        }
        createdDictionaries.push(dictionarySnapshot(createdDictionary))
      }
    }
    if (original.is_auto_check !== false) {
      const latest = await readConfig(api)
      if (!isDeepStrictEqual(latest, original)) {
        throw new Error('BLOCKED: quality settings changed during setup')
      }
      // Restore even if the write succeeds but its response is interrupted.
      configChanged = true
      await api.postBusiness(savePath, {
        configData: JSON.stringify({ ...original, is_auto_check: false })
      })
    }
    const prepared = await readConfig(api)
    if (prepared.is_auto_check !== false) throw new Error('Manual OQC setting did not persist')
    pushCheck(caseRecord, '临时人工 OQC 场景配置回读：关闭自动质检并使用手工核批', true)
    result = await run()
  } catch (error) {
    failure = error
  } finally {
    const cleanupErrors = []
    if (configChanged) {
      try {
        const latest = await readConfig(api)
        if (latest.is_auto_check !== false && latest.is_auto_check !== original.is_auto_check) {
          throw new Error('Concurrent auto-check change detected; do not overwrite it')
        }
        if (latest.is_auto_check === false) {
          if (Object.hasOwn(original, 'is_auto_check')) latest.is_auto_check = original.is_auto_check
          else delete latest.is_auto_check
          await api.postBusiness(savePath, { configData: JSON.stringify(latest) })
        }
        const restored = await readConfig(api)
        if (restored.is_auto_check !== original.is_auto_check) {
          throw new Error('Original auto-check setting was not restored')
        }
      } catch (error) { cleanupErrors.push(error) }
    }
    for (const policy of created.reverse()) {
      try {
        const row = dataOf(await api.getBusiness(
          `/mes/basBillOptions/queryById?id=${encodeURIComponent(policy.id)}`
        ))
        if (!isDeepStrictEqual(policySnapshot(row), policy.snapshot)) {
          throw new Error('Temporary OQC policy changed concurrently; do not delete it')
        }
        await api.deleteBusiness(`/mes/basBillOptions/delete?id=${encodeURIComponent(policy.id)}`)
        if ((await policyRows(api, row.billType)).some((item) => String(item.id) === policy.id)) {
          throw new Error('Temporary OQC policy was not removed')
        }
      } catch (error) { cleanupErrors.push(error) }
    }
    for (const dictionary of createdDictionaries.reverse()) {
      try {
        const current = await findDictionary(api, dictionary.value, dependencies)
        if (!current) continue
        if (!isDeepStrictEqual(dictionarySnapshot(current), dictionary)) {
          throw new Error(`Temporary bill_type dictionary changed concurrently: ${dictionary.value}`)
        }
        await api.deleteBusiness(`/system/dict-data/delete?id=${encodeURIComponent(dictionary.id)}`)
        const remaining = await findDictionary(api, dictionary.value, dependencies)
        if (remaining && String(remaining.id) === dictionary.id) {
          throw new Error(`Temporary bill_type dictionary was not removed: ${dictionary.value}`)
        }
      } catch (error) { cleanupErrors.push(error) }
    }
    pushCheck(caseRecord, 'OQC 场景结束恢复自动质检并清除本轮临时审批策略',
      cleanupErrors.length === 0, cleanupErrors.map((error) => error.message).join('; '))
    if (cleanupErrors.length) {
      failure = new AggregateError([...(failure ? [failure] : []), ...cleanupErrors],
        'Manual OQC scenario cleanup failed')
    }
  }
  if (failure) throw failure
  return result
}
