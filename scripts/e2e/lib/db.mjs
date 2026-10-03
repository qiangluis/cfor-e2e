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

export function assertWriteTestSnapshot (rows) {
  const count = (tag) => {
    const row = rows.find((item) => item[0] === tag)
    if (!row || !/^\d+$/.test(row[1] ?? '')) {
      throw new Error(`BLOCKED: 写侧安全前置缺少有效的 ${tag} 数据库证据`)
    }
    return Number(row[1])
  }
  for (const tag of ['failed-migrations', 'enabled-jobs', 'active-triggers']) {
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
    WHERE TRIGGER_STATE IN ('WAITING', 'ACQUIRED', 'BLOCKED')
  `)
  if (!snapshot.available) throw new Error(`BLOCKED: ${snapshot.reason}`)
  caseRecord.database = [...(caseRecord.database || []), { stage: 'write-preflight', ...snapshot }]
  assertWriteTestSnapshot(snapshot.rows)
}
