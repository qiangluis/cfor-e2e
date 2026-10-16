import { spawn } from 'node:child_process'
import { config } from '../config/index.mjs'

export const databaseConfigured = () => Boolean(config.db.host && config.db.name && config.db.user)

export function assertLocalDatabase (db = config.db) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(db.host) ||
      String(db.port) !== '3306' || db.name !== 'cfor_admin_standard') {
    throw new Error('Database assertions only allow loopback:3306/cfor_admin_standard')
  }
}

export const runReadOnlySql = async (sql) => {
  if (!databaseConfigured()) {
    return {
      available: false,
      rows: [],
      reason: 'CFOR_DB_HOST/CFOR_DB_USER/CFOR_DB_NAME 未配置'
    }
  }

  assertLocalDatabase()
  const args = [
    '--batch',
    '--raw',
    '--skip-column-names',
    '--host',
    config.db.host,
    '--port',
    config.db.port,
    '--user',
    config.db.user,
    config.db.name,
    '--execute',
    `START TRANSACTION READ ONLY; ${sql}; ROLLBACK`
  ]
  const rows = []
  const stderr = []
  await new Promise((resolve, reject) => {
    const child = spawn('mysql', args, {
      env: {
        ...process.env,
        MYSQL_PWD: config.db.password
      }
    })
    child.stdout.on('data', (chunk) => rows.push(chunk.toString()))
    child.stderr.on('data', (chunk) => stderr.push(chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.join('').trim() || `mysql exited with ${code}`))
    })
  })
  return {
    available: true,
    rows: rows
      .join('')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((row) => row.split('\t'))
  }
}

/**
 * Execute a deliberately scoped local fixture mutation.
 *
 * This helper is intentionally unavailable for online targets or when write
 * fixtures are not explicitly enabled. Callers must still restrict the SQL to
 * records owned by the current fixture and verify the result afterwards.
 */
export const runLocalFixtureSql = async (sql) => {
  if (process.env.CFOR_E2E_WRITE_FIXTURES !== 'true') {
    throw new Error('BLOCKED: CFOR_E2E_WRITE_FIXTURES=true 未启用')
  }
  if (config.target !== 'local') {
    throw new Error('BLOCKED: 本地测试夹具写入只允许 local 目标')
  }
  if (!databaseConfigured()) {
    throw new Error('BLOCKED: CFOR_DB_HOST/CFOR_DB_USER/CFOR_DB_NAME 未配置')
  }
  assertLocalDatabase()

  const args = [
    '--batch',
    '--raw',
    '--skip-column-names',
    '--host',
    config.db.host,
    '--port',
    config.db.port,
    '--user',
    config.db.user,
    config.db.name,
    '--execute',
    sql
  ]
  const stdout = []
  const stderr = []
  await new Promise((resolve, reject) => {
    const child = spawn('mysql', args, {
      env: {
        ...process.env,
        MYSQL_PWD: config.db.password
      }
    })
    child.stdout.on('data', (chunk) => stdout.push(chunk.toString()))
    child.stderr.on('data', (chunk) => stderr.push(chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.join('').trim() || `mysql exited with ${code}`))
    })
  })
  return stdout
    .join('')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((row) => row.split('\t'))
}

export function assertWriteTestSnapshot (rows) {
  if (!Array.isArray(rows)) throw new Error('BLOCKED: 写侧安全前置缺少数据库证据')
  const count = (tag) => {
    const matches = rows.filter((item) => Array.isArray(item) && item[0] === tag)
    const row = matches[0]
    if (matches.length !== 1 || row.length !== 2 || !/^\d+$/.test(row[1] ?? '')) {
      throw new Error(`BLOCKED: 写侧安全前置缺少有效的 ${tag} 数据库证据`)
    }
    return Number(row[1])
  }
  for (const tag of ['failed-migrations', 'enabled-jobs', 'active-triggers', 'active-database-writers']) {
    if (count(tag) !== 0) {
      throw new Error(`BLOCKED: 写侧安全前置未通过：${tag} 必须为 0`)
    }
  }
}

export async function assertLocalWriteSafety (caseRecord) {
  const snapshot = await runReadOnlySql(`
    SELECT 'failed-migrations', COUNT(*) FROM flyway_schema_history WHERE success = 0;
    SELECT 'enabled-jobs', COUNT(*) FROM infra_job WHERE deleted = 0 AND status = 1;
    SELECT 'active-triggers', COUNT(*) FROM QRTZ_TRIGGERS
    WHERE TRIGGER_STATE IN ('WAITING', 'ACQUIRED', 'BLOCKED');
    SELECT 'active-database-writers', COUNT(*)
    FROM information_schema.PROCESSLIST
    WHERE DB = DATABASE() AND ID <> CONNECTION_ID()
      AND COMMAND <> 'Sleep'
      AND UPPER(LTRIM(INFO)) REGEXP '^(INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP|TRUNCATE|RENAME|LOAD)[[:space:]]'
  `)
  if (!snapshot.available) throw new Error(`BLOCKED: ${snapshot.reason}`)
  caseRecord.database = [...(caseRecord.database || []), { stage: 'write-preflight', ...snapshot }]
  assertWriteTestSnapshot(snapshot.rows)
}
