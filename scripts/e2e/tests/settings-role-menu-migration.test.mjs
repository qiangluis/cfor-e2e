import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import {
  TARGET, SNAPSHOT_TABLES, SETTINGS_SPEC_SNAPSHOT_TABLES, MARKER_TABLE,
  makeTempSchemaName, isSafeTempSchemaName, parseArgs,
  buildMysqlArgs, buildMysqldumpArgs, buildMigrationSourceInput, buildSettingsReplaySourceInput,
  buildPermissionSnapshotSql, buildExplainSql, buildTenantProjectionSql,
  runProcess, runDumpIntoMysql, createDumpGuard, canDropSchema,
  cleanupOwnedSchema, auditPermissions, verifyMigrationOutput, runVerification
} from '../../../../cfor/cfor-admin/scripts/verify-settings-role-menu-migration.mjs'

const schema = makeTempSchemaName('a123456789abcdef')
const owner = {
  schemaName: schema, marker: 'b'.repeat(32),
  targetHost: TARGET.host, targetPort: TARGET.port, sourceDatabase: TARGET.database,
  preflightSchemaAbsent: true, schemaCreated: true, markerCreated: true
}
const summary = {
  menu_rows: 10, visible_menu_count: 8, role_rows: 5,
  grant_count: 12, navigation_active_count: 3, tenant_package_active_count: 1
}
const summaryOutput = Object.entries(summary).map(([key, value]) => `${key}\t${value}`).join('\n')
const specSummaryOutput = `${summaryOutput}\ndict_type_rows\t4\ndict_data_rows\t8\ntenant_projection_rows\t2`
const indexes = [
  'idx_system_role_menu_tenant_menu_deleted_role\ttenant_id,menu_id,deleted,role_id\t1',
  'idx_system_role_menu_tenant_role_deleted_menu\ttenant_id,role_id,deleted,menu_id\t1'
].join('\n')
const migrationOutputFor = (summaryText) => [
  'index_first_summary', summaryText, 'index_first_indexes', indexes, 'index_first_ms\t5',
  '1', '1', 'index_second_summary', summaryText, 'index_second_indexes', indexes,
  'index_second_ms\t1', 'settings_ms\t7', 'migration_complete'
].join('\n')
const migrationOutput = migrationOutputFor(summaryOutput)

function trackedSpawn(records, replace) {
  return (command, args, options) => {
    assert.equal(options.shell, false)
    const actual = replace ? replace(command, args) : [command, args]
    const child = spawn(actual[0], actual[1], options)
    const record = { child, closed: false }
    child.on('close', () => { record.closed = true })
    records.push(record)
    return child
  }
}

async function guarded(chunks, options) {
  const stream = Readable.from(chunks).pipe(createDumpGuard(schema, options))
  let result = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => { result += chunk })
  await finished(stream)
  return result
}

function row(overrides = {}) {
  return {
    tenantId: '1', roleId: '21', roleCode: 'readonly', roleStatus: 0,
    menuId: '100', permission: 'oa:contact:query', visible: 1,
    componentName: 'SettingsSpecContact', ...overrides
  }
}

function mockRehearsal({
  before = [], after = [], replayAfter = after, afterSummaryOutput, replaySummaryOutput,
  replayOutput = 'settings_replay_ms\t3\nsettings_replay_complete',
  failSource = false, failReplay, exists = false, dumpImpl, failTenantProjection = false
} = {}) {
  const calls = []
  let marker
  let snapshots = 0
  let summaries = 0
  const queryImpl = async (db, sql, options) => {
    calls.push({ db, sql, options })
    if (sql.includes('SELECT SCHEMA_NAME')) return { stdout: `${TARGET.database}\n${exists ? schema : ''}` }
    if (sql.includes("ENGINE='InnoDB'")) return {
      stdout: (sql.includes("'system_dict_type'") ? SETTINGS_SPEC_SNAPSHOT_TABLES : SNAPSHOT_TABLES).join('\n')
    }
    if (sql.startsWith('SELECT COLUMN_NAME')) return { stdout: 'deleted\nid' }
    if (sql.startsWith('CREATE TABLE') && sql.includes('`.`system_tenant`')) {
      if (failTenantProjection) throw Object.assign(new Error('private SQL values'), { code: 'SQL_ERROR' })
      return { stdout: '' }
    }
    if (sql.startsWith('CREATE TABLE')) {
      marker = sql.match(/COMMENT='([a-f0-9]+)'/)[1]
      return { stdout: '' }
    }
    if (sql.startsWith('CREATE DATABASE') || sql.startsWith('DROP DATABASE')) return { stdout: '' }
    if (sql.includes('SELECT TABLE_COMMENT')) return { stdout: marker }
    if (sql.includes(`FROM \`${MARKER_TABLE}\``)) return { stdout: '1' }
    if (sql === 'SELECT @@port;') return { stdout: '3306' }
    if (sql.includes('FROM information_schema.PROCESSLIST')) return { stdout: '' }
    if (sql.includes('source ')) {
      if (sql.includes("'settings_replay_complete'")) {
        if (failReplay) throw Object.assign(new Error('private replay SQL must not leak'), { code: failReplay })
        return { stdout: replayOutput }
      }
      if (failSource) throw Object.assign(new Error('SQL secret value must not leak'), { code: 'SQL_ERROR' })
      return { stdout: migrationOutputFor(sql.includes("'dict_type_rows'") ? specSummaryOutput : summaryOutput) }
    }
    if (sql.includes("SELECT 'menu_rows'")) {
      const summaryIndex = summaries++
      return { stdout: (summaryIndex === 2 ? replaySummaryOutput : undefined) ??
        (summaryIndex > 0 ? afterSummaryOutput : undefined) ??
        (sql.includes("'dict_type_rows'") ? specSummaryOutput : summaryOutput) }
    }
    if (sql.startsWith('SELECT JSON_OBJECT')) {
      const snapshotIndex = snapshots++
      return { stdout: (snapshotIndex === 0 ? before : snapshotIndex === 1 ? after : replayAfter)
        .map((value) => JSON.stringify(value)).join('\n') }
    }
    if (sql.startsWith('SET @verify_tenant')) return { stdout: '1\tSIMPLE\tsystem_role_menu\tref\tindex' }
    throw new Error(`Unexpected mock query: ${sql}`)
  }
  return {
    calls,
    execute: (overrides = {}) => runVerification({
      schemaName: schema, timeoutMs: 2000, queryImpl,
      readMigrationImpl: async () => '-- offline SQL',
      dumpImpl: dumpImpl || (async () => ({ copied: true })),
      ...overrides
    })
  }
}

test('fixed TCP target cannot be overridden by CLI or write-client database', () => {
  assert.deepEqual(TARGET, { host: '127.0.0.1', port: '3306', database: 'cfor_admin_standard' })
  assert.throws(() => { TARGET.host = 'remote' }, TypeError)
  for (const arg of ['--host', '--database', '--port', '--production']) assert.throws(() => parseArgs([arg, 'other']))
  assert.throws(() => buildMysqlArgs(TARGET.database))
  assert.throws(() => buildMysqlArgs('cfor_migration_check_other'))
  const args = buildMysqlArgs(schema)
  assert.deepEqual(args.slice(0, 2), ['--no-defaults', '--no-login-paths'])
  assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1')
  assert.equal(args[args.indexOf('--port') + 1], '3306')
  assert.ok(args.includes('--skip-force'))
  assert.ok(args.includes('--skip-reconnect'))
  assert.ok(!args.some((arg) => /password/i.test(arg)))
})

test('dump contains exactly five tables with single-transaction and no triggers or routines', () => {
  const args = buildMysqldumpArgs()
  assert.deepEqual(args.slice(args.indexOf(TARGET.database) + 1), SNAPSHOT_TABLES)
  for (const arg of ['--single-transaction', '--skip-triggers', '--skip-events', '--skip-routines',
    '--no-create-db', '--no-tablespaces', '--skip-lock-tables', '--skip-add-locks']) assert.ok(args.includes(arg))
  assert.ok(!args.includes('--all-databases'))
  assert.ok(!args.includes('--databases'))
})

test('settings-spec dumps exactly seven tables in one transaction and never dumps system_tenant', () => {
  const args = buildMysqldumpArgs({ settingsSpec: true })
  assert.deepEqual(args.slice(args.indexOf(TARGET.database) + 1), [
    ...SNAPSHOT_TABLES, 'system_dict_type', 'system_dict_data'
  ])
  assert.ok(args.includes('--single-transaction'))
  assert.ok(!args.includes('system_tenant'))
  assert.ok(!args.includes('--databases'))
  assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1')
  assert.equal(args[args.indexOf('--port') + 1], '3306')
})

test('settings-spec and index-only are explicitly mutually exclusive', async () => {
  assert.equal(parseArgs(['--settings-spec']).settingsSpec, true)
  assert.equal(parseArgs(['--settings-spec']).indexOnly, false)
  assert.throws(() => parseArgs(['--settings-spec', '--index-only']))
  assert.throws(() => parseArgs(['--index-only', '--settings-spec']))
  await assert.rejects(runVerification({ indexOnly: true, settingsSpec: true }))
  assert.throws(() => buildMigrationSourceInput(undefined, undefined, { indexOnly: true, settingsSpec: true }))
})

test('tenant projection copies exactly id/deleted with SELECT from the fixed source into owned schema only', () => {
  assert.equal(buildTenantProjectionSql(schema),
    `CREATE TABLE \`${schema}\`.\`system_tenant\` (id BIGINT NOT NULL PRIMARY KEY, deleted BIT(1) NOT NULL) ENGINE=InnoDB;
INSERT INTO \`${schema}\`.\`system_tenant\` (id,deleted)
SELECT id,deleted FROM \`cfor_admin_standard\`.\`system_tenant\`;`)
  assert.throws(() => buildTenantProjectionSql(TARGET.database))
  assert.throws(() => buildTenantProjectionSql('production'))
  assert.ok(!/SELECT \*|contact|phone|password|email/i.test(buildTenantProjectionSql(schema)))
})

test('random schema is unique and strictly validated', () => {
  assert.ok(isSafeTempSchemaName(makeTempSchemaName()))
  assert.notEqual(makeTempSchemaName(), makeTempSchemaName())
  assert.throws(() => makeTempSchemaName('x'))
  assert.throws(() => makeTempSchemaName('A'.repeat(16)))
  assert.ok(!isSafeTempSchemaName(TARGET.database))
})

test('formal sources share one input, 0850 twice, 0900 once, with optional client abort flag', () => {
  const input = buildMigrationSourceInput()
  const sources = input.split('\n').filter((line) => line.startsWith('source '))
  assert.equal(sources.length, 3)
  assert.equal(sources[0], sources[1])
  assert.match(sources[0], /V202610160850__/)
  assert.match(sources[2], /V202610160900__/)
  assert.ok(buildMysqlArgs(schema, { abortSourceOnError: true }).includes('--abort-source-on-error'))
  assert.throws(() => buildMigrationSourceInput('/tmp/a.sql;quit', '/tmp/b.sql'))
})

test('settings replay sources only formal 0900 in one connection with completion and timing evidence', () => {
  const input = buildSettingsReplaySourceInput()
  const sources = input.split('\n').filter((line) => line.startsWith('source '))
  assert.equal(sources.length, 1)
  assert.match(sources[0], /V202610160900__/)
  assert.ok(!input.includes('V202610160850'))
  assert.ok(!input.includes('/tmp/'))
  assert.ok(!/USE |CREATE DATABASE|DROP DATABASE/i.test(input))
  assert.match(input, /SELECT 'settings_replay_ms'/)
  assert.match(input, /SELECT 'settings_replay_complete'/)
  for (const file of ['/tmp/a.sql;quit', '/tmp/a b.sql', 'relative.sql']) {
    assert.throws(() => buildSettingsReplaySourceInput(file))
  }
})

test('dump guard preserves Unicode even when split inside a UTF8 character', async () => {
  const dump = "INSERT INTO `system_menu` VALUES (1,'\u8bbe\u7f6e');\n"
  const bytes = Buffer.from(dump)
  const offset = bytes.indexOf(Buffer.from('\u8bbe')) + 1
  assert.equal(await guarded([bytes.subarray(0, offset), bytes.subarray(offset)]), dump)
})

test('dump guard rejects schema switches, extra tables, and qualified writes', async () => {
  for (const sql of [
    'USE `cfor_admin_standard`;\n', 'CREATE DATABASE `bad`;\n',
    '/*!50000 USE `cfor_admin_standard` */;\n',
    'INSERT INTO `system_users` VALUES (1);\n',
    'INSERT INTO `cfor_admin_standard`.`system_menu` VALUES (1);\n',
    'source /tmp/other.sql;\n'
  ]) await assert.rejects(guarded([Buffer.from(sql)]), { code: 'DUMP_GUARD' })
})

test('dictionary dump rows require settings-spec; full tenant rows remain forbidden in both modes', async () => {
  for (const table of ['system_dict_type', 'system_dict_data']) {
    const sql = Buffer.from(`INSERT INTO \`${table}\` VALUES (1);\n`)
    await assert.rejects(guarded([sql]), { code: 'DUMP_GUARD' })
    assert.equal(await guarded([sql], { settingsSpec: true }), sql.toString())
  }
  for (const options of [{}, { settingsSpec: true }]) {
    await assert.rejects(guarded([Buffer.from('CREATE TABLE `system_tenant` (id BIGINT);\n')], options), { code: 'DUMP_GUARD' })
    await assert.rejects(guarded([Buffer.from('INSERT INTO `system_users` VALUES (1);\n')], options), { code: 'DUMP_GUARD' })
  }
})

test('runProcess succeeds without TDZ and returns stdout after close', async () => {
  const records = []
  const result = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
    input: 'offline ok', timeoutMs: 2000, spawnImpl: trackedSpawn(records)
  })
  assert.equal(result.stdout, 'offline ok')
  assert.ok(records[0].closed)
})

test('runProcess nonzero failure is reaped and never exposes stderr', async () => {
  const records = []
  await assert.rejects(runProcess(process.execPath, ['-e',
    "process.stderr.write('private-password-and-SQL');process.exit(7)"
  ], { timeoutMs: 2000, spawnImpl: trackedSpawn(records) }), (error) => {
    assert.equal(error.code, 'CLIENT_EXIT')
    assert.ok(!JSON.stringify(error).includes('private-password'))
    assert.ok(!error.message.includes('SQL'))
    assert.equal(error.stderr, undefined)
    return true
  })
  assert.ok(records[0].closed)
})

test('runProcess reports spawn failure without raw OS or credential diagnostics', async () => {
  await assert.rejects(runProcess('/nonexistent-cfor-offline-client', [], {
    timeoutMs: 2000
  }), { code: 'SPAWN_FAILED' })
})

test('runProcess timeout kills a TERM-resistant child and awaits close', async () => {
  const records = []
  await assert.rejects(runProcess(process.execPath, ['-e',
    "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
  ], { timeoutMs: 600, killGraceMs: 30, spawnImpl: trackedSpawn(records) }), { code: 'ETIMEDOUT' })
  assert.ok(records[0].closed)
  assert.ok(records[0].child.signalCode)
})

test('SQL source error aborts a client even if it would otherwise exit zero', async () => {
  const records = []
  await assert.rejects(runProcess(process.execPath, ['-e',
    "process.stderr.write('ERROR 1064 private SQL and password\\n');setTimeout(()=>process.exit(0),1500)"
  ], { timeoutMs: 2000, spawnImpl: trackedSpawn(records) }), (error) => {
    assert.equal(error.code, 'SQL_ERROR')
    assert.ok(!error.message.includes('private'))
    return true
  })
  assert.ok(records[0].closed)
})

test('AbortSignal waits for child close before returning', async () => {
  const records = []
  const controller = new AbortController()
  const operation = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    timeoutMs: 2000, signal: controller.signal, spawnImpl: trackedSpawn(records)
  })
  const timer = setTimeout(() => controller.abort(), 150)
  await assert.rejects(operation, { code: 'ABORT_ERR' })
  clearTimeout(timer)
  assert.ok(records[0].closed)
})

test('dump/load success uses real offline Node pipes and reaps both children', async () => {
  const records = []
  const spawnImpl = trackedSpawn(records, (command) => [process.execPath, ['-e',
    command === 'offline-dump'
      ? "process.stdout.write('INSERT INTO `system_menu` VALUES (1);\\n')"
      : 'process.stdin.resume()'
  ]])
  await runDumpIntoMysql({
    targetSchema: schema, dumpBin: 'offline-dump', mysqlBin: 'offline-load', spawnImpl, timeoutMs: 2000
  })
  assert.equal(records.length, 2)
  assert.ok(records.every((record) => record.closed))
})

test('settings-spec dump process receives seven-table scope and streams dictionary rows offline', async () => {
  const records = []
  const spawnImpl = trackedSpawn(records, (command, args) => {
    if (command === 'offline-dump') {
      assert.deepEqual(args.slice(args.indexOf(TARGET.database) + 1), SETTINGS_SPEC_SNAPSHOT_TABLES)
    }
    return [process.execPath, ['-e', command === 'offline-dump'
      ? "process.stdout.write('INSERT INTO `system_dict_type` VALUES (1);\\nINSERT INTO `system_dict_data` VALUES (2);\\n')"
      : 'process.stdin.resume()']]
  })
  await runDumpIntoMysql({
    targetSchema: schema, settingsSpec: true, dumpBin: 'offline-dump', mysqlBin: 'offline-load',
    timeoutMs: 2000, spawnImpl
  })
  assert.equal(records.length, 2)
  assert.ok(records.every((record) => record.closed))
})

test('dump/load timeout kills and awaits both TERM-resistant processes', async () => {
  const records = []
  const spawnImpl = trackedSpawn(records, () => [process.execPath, ['-e',
    "process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000)"
  ]])
  await assert.rejects(runDumpIntoMysql({
    targetSchema: schema, dumpBin: 'offline-dump', mysqlBin: 'offline-load', spawnImpl, timeoutMs: 600
  }), { code: 'ETIMEDOUT' })
  assert.equal(records.length, 2)
  assert.ok(records.every((record) => record.closed))
})

test('dump/load error terminates the surviving process before cleanup is possible', async () => {
  const records = []
  const spawnImpl = trackedSpawn(records, (command) => [process.execPath, ['-e',
    command === 'offline-dump'
      ? "process.stderr.write('private SQL');process.exit(8)"
      : 'process.stdin.resume();setInterval(()=>{},1000)'
  ]])
  await assert.rejects(runDumpIntoMysql({
    targetSchema: schema, dumpBin: 'offline-dump', mysqlBin: 'offline-load', spawnImpl, timeoutMs: 2000
  }))
  assert.ok(records.every((record) => record.closed))
})

test('cleanup gate rejects wrong host/db, pre-existing or unowned schemas and missing marker nonce', () => {
  assert.ok(canDropSchema(owner))
  for (const patch of [
    { targetHost: 'localhost' }, { targetPort: '3307' }, { sourceDatabase: 'production' },
    { schemaName: TARGET.database }, { schemaCreated: false }, { preflightSchemaAbsent: false },
    { marker: '' }
  ]) assert.ok(!canDropSchema({ ...owner, ...patch }))
})

test('server marker mismatch refuses DROP even with locally acknowledged creation', async () => {
  const sqls = []
  const cleanup = await cleanupOwnedSchema(owner, async (_db, sql) => {
    sqls.push(sql)
    return { stdout: sql.includes('TABLE_COMMENT') ? 'wrong-marker' : '5' }
  })
  assert.equal(cleanup.dropped, false)
  assert.ok(sqls.every((sql) => !sql.includes('DROP DATABASE')))
})

test('cleanup confirms matching marker payload and only drops exact owned copy', async () => {
  const sqls = []
  const cleanup = await cleanupOwnedSchema(owner, async (_db, sql) => {
    sqls.push(sql)
    if (sql === 'SELECT @@port;') return { stdout: '3306' }
    if (sql.includes('FROM information_schema.PROCESSLIST')) return { stdout: '' }
    return { stdout: sql.includes('TABLE_COMMENT') ? owner.marker : sql.startsWith('SELECT') ? '1' : '' }
  })
  assert.equal(cleanup.dropped, true)
  assert.equal(sqls.at(-1), `DROP DATABASE \`${schema}\`;`)
  assert.ok(sqls[1].includes("source_database='cfor_admin_standard'"))
  assert.equal(cleanup.serverConnectionsDrained, true)
})

test('cleanup kills only exact copy sessions after marker/port confirmation and drains before DROP', async () => {
  const sqls = []
  let processReads = 0
  const cleanup = await cleanupOwnedSchema(owner, async (db, sql) => {
    sqls.push(sql)
    if (sql.includes('TABLE_COMMENT')) return { stdout: owner.marker }
    if (sql.includes(`FROM \`${MARKER_TABLE}\``)) return { stdout: '1' }
    assert.equal(db, 'information_schema')
    if (sql === 'SELECT @@port;') return { stdout: '3306' }
    if (sql.startsWith('SELECT CAST(ID AS CHAR)')) {
      assert.ok(sql.includes(`BINARY DB=BINARY '${schema}'`))
      assert.ok(sql.includes('ID<>CONNECTION_ID()'))
      return { stdout: processReads++ === 0 ? `17\t${schema}\n9007199254740993\t${schema}` : '' }
    }
    if (sql.startsWith('SELECT COUNT(*) FROM information_schema.PROCESSLIST')) {
      assert.ok(sql.includes(`BINARY DB=BINARY '${schema}'`))
      return { stdout: '1' }
    }
    return { stdout: '' }
  })
  assert.equal(cleanup.dropped, true)
  assert.deepEqual(cleanup.terminatedConnectionIds, ['17', '9007199254740993'])
  assert.deepEqual(sqls.filter((sql) => sql.startsWith('KILL')), [
    'KILL CONNECTION 17;', 'KILL CONNECTION 9007199254740993;'
  ])
  assert.ok(sqls.indexOf('SELECT @@port;') > sqls.findIndex((sql) => sql.includes(`FROM \`${MARKER_TABLE}\``)))
  assert.ok(sqls.at(-2).startsWith('SELECT CAST(ID AS CHAR)'))
  assert.equal(sqls.at(-1), `DROP DATABASE \`${schema}\`;`)
})

test('cleanup rejects source or other-copy sessions and invalid IDs before issuing any KILL or DROP', async () => {
  for (const processList of [
    `21\t${TARGET.database}`, `21\t${makeTempSchemaName('c'.repeat(16))}`,
    `21;KILL 1\t${schema}`, `0\t${schema}`, `18446744073709551616\t${schema}`,
    `21\t${schema}\n22\t${TARGET.database}`
  ]) {
    const sqls = []
    await assert.rejects(cleanupOwnedSchema(owner, async (_db, sql) => {
      sqls.push(sql)
      if (sql.includes('TABLE_COMMENT')) return { stdout: owner.marker }
      if (sql.includes(`FROM \`${MARKER_TABLE}\``)) return { stdout: '1' }
      if (sql === 'SELECT @@port;') return { stdout: '3306' }
      if (sql.startsWith('SELECT CAST(ID AS CHAR)')) return { stdout: processList }
      throw new Error('Unexpected SQL')
    }))
    assert.ok(sqls.every((sql) => !sql.startsWith('KILL') && !sql.startsWith('DROP')))
  }
})

test('cleanup does not inspect or kill sessions if fixed host/port or server port checks fail', async () => {
  for (const patch of [{ targetHost: 'remote' }, { targetPort: '3307' }, {}]) {
    const sqls = []
    const cleanup = await cleanupOwnedSchema({ ...owner, ...patch }, async (_db, sql) => {
      sqls.push(sql)
      if (sql.includes('TABLE_COMMENT')) return { stdout: owner.marker }
      if (sql.includes(`FROM \`${MARKER_TABLE}\``)) return { stdout: '1' }
      if (sql === 'SELECT @@port;') return { stdout: '3307' }
      throw new Error('Unexpected SQL')
    })
    assert.equal(cleanup.dropped, false)
    assert.ok(sqls.every((sql) => !/PROCESSLIST|^KILL|^DROP/.test(sql)))
  }
})

test('cleanup rechecks each session DB and never kills one that left the owned copy', async () => {
  const sqls = []
  let processReads = 0
  const cleanup = await cleanupOwnedSchema(owner, async (_db, sql) => {
    sqls.push(sql)
    if (sql.includes('TABLE_COMMENT')) return { stdout: owner.marker }
    if (sql.includes(`FROM \`${MARKER_TABLE}\``)) return { stdout: '1' }
    if (sql === 'SELECT @@port;') return { stdout: '3306' }
    if (sql.startsWith('SELECT CAST(ID AS CHAR)')) return { stdout: processReads++ === 0 ? `37\t${schema}` : '' }
    if (sql.startsWith('SELECT COUNT(*) FROM information_schema.PROCESSLIST')) return { stdout: '0' }
    return { stdout: '' }
  })
  assert.equal(cleanup.dropped, true)
  assert.ok(sqls.every((sql) => !sql.startsWith('KILL')))
})

test('cleanup refuses DROP if PROCESSLIST is unreadable or owned server session cannot be killed', async () => {
  for (const failure of ['list', 'kill']) {
    const sqls = []
    await assert.rejects(cleanupOwnedSchema(owner, async (_db, sql) => {
      sqls.push(sql)
      if (sql.includes('TABLE_COMMENT')) return { stdout: owner.marker }
      if (sql.includes(`FROM \`${MARKER_TABLE}\``)) return { stdout: '1' }
      if (sql === 'SELECT @@port;') return { stdout: '3306' }
      if (sql.startsWith('SELECT CAST(ID AS CHAR)')) {
        if (failure === 'list') throw new Error('No PROCESSLIST access')
        return { stdout: `37\t${schema}` }
      }
      if (sql.startsWith('SELECT COUNT(*) FROM information_schema.PROCESSLIST')) return { stdout: '1' }
      if (sql.startsWith('KILL')) throw new Error('Cannot kill')
      throw new Error('Unexpected SQL')
    }))
    assert.ok(sqls.every((sql) => !sql.startsWith('DROP')))
  }
})

test('index evidence requires exact nonunique columns and stable summaries across both runs', () => {
  assert.equal(verifyMigrationOutput(migrationOutput, summary).idempotent, true)
  assert.throws(() => verifyMigrationOutput(migrationOutput.replace('deleted,role_id', 'role_id,deleted'), summary))
  assert.throws(() => verifyMigrationOutput(migrationOutput.replace('grant_count\t12', 'grant_count\t13'), summary))
  assert.throws(() => verifyMigrationOutput(migrationOutput.replace('migration_complete', ''), summary))
})

test('permission audit separates old permission alias from genuinely new permission, with tenant isolation', () => {
  const before = [row({ menuId: '1' }), row({ tenantId: '2', menuId: '2', permission: 'oa:contact:update' })]
  const after = [...before, row(), row({ menuId: '101', permission: 'oa:contact:update' })]
  const audit = auditPermissions(before, after)
  assert.equal(audit.nonAdminAddedNonEmptyPermissionGrantCount, 2)
  assert.equal(audit.nonAdminNewRolePermissionCount, 1)
  assert.equal(audit.allRoleNewPermissionCount, 1)
  assert.equal(audit.permissionGrowthZero, false)
  assert.equal(audit.perNonAdminRole[0].previouslyHeldSamePermissionCount, 1)
  assert.equal(audit.addedPermissionGrants[0].previouslyHeldSamePermission, true)
  assert.equal(audit.addedPermissionGrants[1].previouslyHeldSamePermission, false)
  assert.equal(audit.beforePermissionSnapshot, before)
})

test('permission report separates enabled roles; system role audited; user links explicitly unverified', () => {
  const audit = auditPermissions([], [
    row(), row({ roleId: '22', roleStatus: 1 }),
    row({ roleId: '23', roleCode: 'super_admin' }),
    row({ roleId: '24', roleCode: 'tenant_admin' }),
    row({ roleId: '25', roleCode: 'system' })
  ])
  assert.equal(audit.affectedNonAdminRoleCount, 3)
  assert.equal(audit.affectedEnabledNonAdminRoleCount, 2)
  assert.equal(audit.enabledNonAdminNewRolePermissionCount, 2)
  assert.equal(audit.allRoleNewPermissionCount, 5)
  assert.equal(audit.enabledRoleNewPermissionCount, 4)
  assert.deepEqual(audit.adminRoleCodesExemptedFromZeroGrowthGate, [])
  assert.equal(audit.activeUserAssociation.verified, false)
  assert.ok(buildPermissionSnapshotSql().includes("'roleStatus', r.status"))
  assert.ok(buildPermissionSnapshotSql().includes('m.status=0'))
  assert.ok(!buildPermissionSnapshotSql().includes('system_user'))
  assert.ok(buildExplainSql('role').includes('SELECT tenant_id, role_id INTO'))
})

test('offline rehearsal succeeds, sources once on one connection, cleans owned copy', async () => {
  const mock = mockRehearsal()
  const result = await mock.execute()
  assert.equal(result.ok, true)
  assert.equal(result.cleanup.dropped, true)
  assert.equal(result.indexMigration.idempotent, true)
  assert.equal(result.settingsReplay, undefined)
  assert.equal(mock.calls.filter(({ sql }) => sql.includes('source ')).length, 1)
  assert.ok(mock.calls.every(({ db }) => db === schema || db === 'information_schema'))
})

test('settings-spec rehearsal copies seven tables plus minimal tenant projection and enforces zero growth', async () => {
  const dumps = []
  const baseline = row({ menuId: '1' })
  const mock = mockRehearsal({
    before: [baseline], after: [baseline, row()],
    dumpImpl: async (options) => { dumps.push(options) }
  })
  const result = await mock.execute({ settingsSpec: true })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'settings-spec')
  assert.deepEqual(result.snapshotTables, SETTINGS_SPEC_SNAPSHOT_TABLES)
  assert.equal(dumps.length, 1)
  assert.equal(dumps[0].settingsSpec, true)
  assert.equal(dumps[0].targetSchema, schema)
  assert.deepEqual(result.tenantProjection.columns, ['id', 'deleted'])
  assert.equal(result.tenantProjection.includedInDump, false)
  assert.equal(result.tenantProjection.consistentWithSevenTableDump, false)
  assert.equal(result.before.dict_type_rows, 4)
  assert.equal(result.before.dict_data_rows, 8)
  assert.equal(result.before.tenant_projection_rows, 2)
  assert.equal(result.permissionAudit.allRoleNewPermissionCount, 0)
  assert.equal(result.settingsReplay.completed, true)
  assert.equal(result.settingsReplay.elapsedMs, 3)
  assert.equal(result.settingsReplay.idempotent, true)
  assert.equal(result.settingsReplay.businessSummaryUnchanged, true)
  assert.equal(result.settingsReplay.permissionSnapshotUnchanged, true)
  assert.equal(result.settingsReplay.permissionGrowthZero, true)
  assert.equal(result.settingsReplay.afterPermissionSnapshot, undefined)
  assert.equal(result.cleanup.dropped, true)
  const projection = mock.calls.find(({ sql }) => sql.startsWith('CREATE TABLE') && sql.includes('`.`system_tenant`'))
  assert.equal(projection.db, schema)
  assert.equal(projection.sql, buildTenantProjectionSql(schema))
  const sources = mock.calls.filter(({ sql }) => sql.includes('source '))
  assert.equal(sources.length, 2)
  assert.equal(sources[0].sql.split('\n').filter((line) => line.startsWith('source ')).length, 3)
  assert.match(sources[0].sql, /V202610160900__/)
  assert.equal(sources[1].sql, buildSettingsReplaySourceInput())
  assert.ok(sources.every(({ db }) => db === schema))
  assert.deepEqual(sources[1].options, sources[0].options)
  const firstAfterSummary = mock.calls.findIndex(({ sql }, index) => index > mock.calls.indexOf(sources[0]) && sql.includes("SELECT 'menu_rows'"))
  const firstAfterPermissions = mock.calls.findIndex(({ sql }, index) => index > firstAfterSummary && sql.startsWith('SELECT JSON_OBJECT'))
  assert.ok(firstAfterPermissions > firstAfterSummary)
  assert.ok(mock.calls.indexOf(sources[1]) > firstAfterPermissions)
})

test('settings replay accepts intended first-run changes and ignores row/key order in logical snapshots', async () => {
  const baseline = row({ menuId: '1' })
  const after = [baseline, row({ roleStatus: 1 })]
  const afterSummary = specSummaryOutput.replace('grant_count\t12', 'grant_count\t13')
  const mock = mockRehearsal({
    before: [baseline], after,
    replayAfter: [...after].reverse().map((value) => Object.fromEntries(Object.entries(value).reverse())),
    afterSummaryOutput: afterSummary,
    replaySummaryOutput: afterSummary.split('\n').reverse().join('\n')
  })
  const result = await mock.execute({ settingsSpec: true })
  assert.equal(result.ok, true)
  assert.equal(result.businessSummaryUnchanged, false)
  assert.equal(result.permissionSnapshotUnchanged, false)
  assert.equal(result.settingsReplay.idempotent, true)
  assert.equal(result.cleanup.dropped, true)
  const snapshots = mock.calls.filter(({ sql }) => sql.startsWith('SELECT JSON_OBJECT'))
  assert.equal(snapshots.length, 3)
  assert.ok(snapshots.every(({ sql }) => !/create_time|update_time|timestamp/i.test(sql)))
})

test('settings replay rejects business summary drift without permission expansion', async () => {
  for (const metric of ['grant_count', 'dict_type_rows', 'dict_data_rows', 'tenant_package_active_count', 'tenant_projection_rows']) {
    const replaySummaryOutput = specSummaryOutput.replace(new RegExp(`${metric}\\t\\d+`), `${metric}\t999`)
    const result = await mockRehearsal({ before: [row()], after: [row()], replaySummaryOutput })
      .execute({ settingsSpec: true })
    assert.equal(result.ok, false, metric)
    assert.equal(result.error.code, 'SETTINGS_SPEC_NOT_IDEMPOTENT', metric)
    assert.equal(result.settingsReplay.businessSummaryUnchanged, false)
    assert.equal(result.settingsReplay.permissionSnapshotUnchanged, true)
    assert.equal(result.settingsReplay.idempotent, false)
    assert.equal(result.settingsReplay.completed, true)
    assert.equal(result.cleanup.dropped, true)
  }
})

test('settings replay rejects removed or remapped grants even if the same permission was already held', async () => {
  const baseline = row({ menuId: '1' })
  const after = [baseline, row()]
  for (const replayAfter of [
    [baseline],
    [baseline, row({ menuId: '101' })],
    [baseline, row({ componentName: 'SettingsSpecDifferent' })],
    [baseline, row({ roleStatus: 1 })]
  ]) {
    const result = await mockRehearsal({ before: [baseline], after, replayAfter }).execute({ settingsSpec: true })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'SETTINGS_SPEC_NOT_IDEMPOTENT')
    assert.equal(result.settingsReplay.permissionGrowthZero, true)
    assert.equal(result.settingsReplay.permissionSnapshotUnchanged, false)
    assert.deepEqual(result.settingsReplay.afterPermissionSnapshot, replayAfter)
    assert.equal(result.cleanup.dropped, true)
  }
})

test('settings replay permission growth checks tenant and role boundaries against the original baseline', async () => {
  for (const changed of [
    { tenantId: '2' }, { roleId: '22' }, { permission: 'oa:contact:update' }
  ]) {
    const replayAfter = [row(), row({ menuId: '101', ...changed })]
    const result = await mockRehearsal({ before: [row()], after: [row()], replayAfter }).execute({ settingsSpec: true })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'AUTHORIZATION_EXPANSION')
    assert.equal(result.permissionAudit.permissionGrowthZero, true)
    assert.equal(result.settingsReplay.permissionGrowthZero, false)
    assert.equal(result.settingsReplay.allRoleNewPermissionCount, 1)
    assert.equal(result.settingsReplay.allRoleNewPermissions.length, 1)
    assert.equal(result.authorizationReviewRequired, true)
    assert.equal(result.cleanup.dropped, true)
  }
})

test('settings replay cannot mask first-run expansion by removing it on the second run', async () => {
  const result = await mockRehearsal({
    before: [], after: [row({ roleStatus: 1 })], replayAfter: []
  }).execute({ settingsSpec: true })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'AUTHORIZATION_EXPANSION')
  assert.equal(result.permissionAudit.allRoleNewPermissionCount, 1)
  assert.equal(result.settingsReplay.allRoleNewPermissionCount, 0)
  assert.equal(result.settingsReplay.idempotent, false)
  assert.equal(result.authorizationReviewRequired, true)
  assert.equal(result.cleanup.dropped, true)
})

test('settings replay SQL failure or timeout retains first-run evidence and always cleans the owned schema', async () => {
  for (const failReplay of ['SQL_ERROR', 'ETIMEDOUT']) {
    const result = await mockRehearsal({ before: [row()], after: [row()], failReplay }).execute({ settingsSpec: true })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, failReplay)
    assert.equal(result.permissionAudit.beforePermissionSnapshot.length, 1)
    assert.equal(result.permissionAudit.afterPermissionSnapshot.length, 1)
    assert.equal(result.settingsReplay.completed, false)
    assert.equal(result.cleanup.dropped, true)
    assert.ok(!JSON.stringify(result).includes('private replay SQL'))
  }
})

test('settings replay must produce valid timing and completion before claiming success', async () => {
  for (const replayOutput of [
    '', 'settings_replay_ms\t3', 'settings_replay_complete',
    'settings_replay_ms\tNaN\nsettings_replay_complete',
    'settings_replay_ms\t-1\nsettings_replay_complete',
    'settings_replay_ms\t\nsettings_replay_complete',
    'settings_replay_ms\t1\nsettings_replay_ms\t2\nsettings_replay_complete'
  ]) {
    const result = await mockRehearsal({ replayOutput }).execute({ settingsSpec: true })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'VERIFY_FAILED')
    assert.equal(result.settingsReplay.completed, false)
    assert.equal(result.cleanup.dropped, true)
  }
})

test('offline CLI plans show two 0900 runs only for settings-spec without connecting to mysql', async () => {
  const script = new URL('../../../../cfor/cfor-admin/scripts/verify-settings-role-menu-migration.mjs', import.meta.url)
  for (const [args, expected] of [[[], 3], [['--index-only'], 2], [['--settings-spec'], 4]]) {
    const { stdout } = await runProcess(process.execPath, [script.pathname, ...args, '--plan'], { timeoutMs: 2000 })
    const plan = JSON.parse(stdout)
    assert.equal(plan.migrationSources.length, expected)
    if (args.includes('--settings-spec')) {
      assert.equal(plan.migrationSources[2], plan.migrationSources[3])
      assert.equal(plan.settingsReplay.sameSchema, true)
      assert.equal(plan.settingsReplay.auditTimestampsCompared, false)
    } else assert.equal(plan.settingsReplay, undefined)
  }
})

test('settings-spec still rejects permission expansion and cleans after tenant projection failure', async () => {
  const expanded = await mockRehearsal({ after: [row({ roleCode: 'super_admin' })] }).execute({ settingsSpec: true })
  assert.equal(expanded.ok, false)
  assert.equal(expanded.error.code, 'AUTHORIZATION_EXPANSION')
  assert.equal(expanded.cleanup.dropped, true)
  const mock = mockRehearsal({ failTenantProjection: true })
  const failed = await mock.execute({ settingsSpec: true })
  assert.equal(failed.error.code, 'SQL_ERROR')
  assert.equal(failed.cleanup.dropped, true)
  assert.ok(mock.calls.every(({ sql }) => !sql.includes('source ')))
  assert.ok(!JSON.stringify(failed).includes('private SQL'))
})

test('offline rehearsal flags non-admin expansion while retaining complete baseline and cleanup', async () => {
  const mock = mockRehearsal({ before: [row({ menuId: '1' })], after: [
    row({ menuId: '1' }), row(), row({ menuId: '102', permission: 'oa:contact:update' })
  ] })
  const result = await mock.execute()
  assert.equal(result.rehearsalCompleted, true)
  assert.equal(result.ok, false)
  assert.equal(result.authorizationReviewRequired, true)
  assert.equal(result.error.code, 'AUTHORIZATION_EXPANSION')
  assert.equal(result.beforePermissionSnapshot.length, 1)
  assert.equal(result.cleanup.dropped, true)
})

test('permission-preserving aliases pass zero-growth gate for all roles including administrators', async () => {
  const before = [
    row({ menuId: '1' }),
    row({ roleId: '23', roleCode: 'super_admin', menuId: '2' }),
    row({ roleId: '24', roleCode: 'tenant_admin', menuId: '3', roleStatus: 1 })
  ]
  const after = [
    ...before,
    ...before.map((value, index) => ({ ...value, menuId: String(100 + index) }))
  ]
  const result = await mockRehearsal({ before, after }).execute()
  assert.equal(result.ok, true)
  assert.equal(result.cleanup.dropped, true)
  assert.equal(result.permissionAudit.addedNonEmptyPermissionGrantCount, 3)
  assert.equal(result.permissionAudit.allRoleNewPermissionCount, 0)
  assert.equal(result.permissionAudit.permissionGrowthZero, true)
  assert.equal(result.authorizationReviewRequired, false)
})

test('administrator permission expansion fails even when non-admin increment is zero', async () => {
  for (const roleCode of ['super_admin', 'tenant_admin', 'system']) {
    const result = await mockRehearsal({ after: [row({ roleCode })] }).execute()
    assert.equal(result.ok, false)
    assert.equal(result.permissionAudit.allRoleNewPermissionCount, 1)
    assert.equal(result.authorizationReviewRequired, true)
    assert.equal(result.error.code, 'AUTHORIZATION_EXPANSION')
    assert.equal(result.cleanup.dropped, true)
  }
})

test('new permission count deduplicates aliases without exempting disabled roles or matching prefixes', () => {
  const audit = auditPermissions(
    [row({ permission: 'oa:contact:queryAll', roleStatus: 1 })],
    [row({ menuId: '101', roleStatus: 1 }), row({ menuId: '102', roleStatus: 1 })]
  )
  assert.equal(audit.allRoleNewPermissionCount, 1)
  assert.equal(audit.enabledRoleNewPermissionCount, 0)
  assert.equal(audit.permissionGrowthZero, false)
  assert.equal(audit.addedPermissionGrants.length, 2)
  assert.ok(audit.addedPermissionGrants.every((grant) => !grant.previouslyHeldSamePermission))
})

test('current formal 160850 remains the sole SQL dependency in explicit index-only mode', async () => {
  const sql = await readFile(new URL(
    '../../../../cfor/cfor-admin/cfor-server/src/main/resources/db/migration/V202610160850__add_system_role_menu_lookup_indexes.sql',
    import.meta.url
  ), 'utf8')
  assert.match(sql, /CREATE INDEX `idx_system_role_menu_tenant_role_deleted_menu`/)
  assert.match(sql, /CREATE INDEX `idx_system_role_menu_tenant_menu_deleted_role`/)
  const readPaths = []
  const baseline = [row({ menuStatus: 0 }), row({ menuId: '22', roleStatus: 1, menuStatus: 1 })]
  const mock = mockRehearsal({ before: baseline, after: [...baseline].reverse() })
  const result = await mock.execute({
    indexOnly: true,
    readMigrationImpl: async (file) => {
      readPaths.push(file)
      assert.match(file, /V202610160850__/)
      return sql
    }
  })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'index-only')
  assert.equal(result.permissionSnapshotUnchanged, true)
  assert.equal(result.businessSummaryUnchanged, true)
  assert.equal(result.settingsReplay, undefined)
  assert.equal(result.cleanup.dropped, true)
  assert.equal(readPaths.length, 1)
  assert.equal(mock.calls.filter(({ sql }) => sql.includes('source ')).length, 1)
  const sourceInput = mock.calls.find(({ sql: input }) => input.includes('source ')).sql
  assert.equal(sourceInput.split('\n').filter((line) => line.startsWith('source ')).length, 2)
  assert.ok(!sourceInput.includes('V202610160900'))
  assert.ok(!sourceInput.includes('/tmp/'))
  assert.ok(!buildPermissionSnapshotSql({ allMenus: true }).includes('m.status=0'))
  assert.equal(parseArgs(['--index-only']).indexOnly, true)
})

test('index-only rejects removed permissions and grant changes even when added permission count is zero', async () => {
  for (const after of [[], [row({ menuId: '2' })]]) {
    const baseline = row({ menuId: '1' })
    const result = await mockRehearsal({ before: [baseline], after }).execute({ indexOnly: true })
    assert.equal(result.permissionAudit.allRoleNewPermissionCount, 0)
    assert.equal(result.permissionSnapshotUnchanged, false)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'INDEX_ONLY_DATA_CHANGED')
    assert.equal(result.cleanup.dropped, true)
  }
})

test('offline source failure retains pre-migration permissions, sanitizes error, and cleans copy', async () => {
  const result = await mockRehearsal({ before: [row()], failSource: true }).execute()
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'SQL_ERROR')
  assert.equal(result.beforePermissionSnapshot.length, 1)
  assert.equal(result.cleanup.dropped, true)
  assert.ok(!JSON.stringify(result).includes('secret value'))
})

test('pre-existing schema is never created, reused, dumped, or dropped', async () => {
  let dumped = false
  const mock = mockRehearsal({ exists: true, dumpImpl: async () => { dumped = true } })
  const result = await mock.execute()
  assert.equal(result.ok, false)
  assert.equal(result.cleanup.dropped, false)
  assert.equal(dumped, false)
  assert.ok(mock.calls.every(({ sql }) => !/CREATE |DROP |source /.test(sql)))
})
