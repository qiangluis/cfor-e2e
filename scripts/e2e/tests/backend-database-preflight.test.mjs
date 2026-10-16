import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL(
  '../../../../cfor/cfor-admin/scripts/check-local-database-preflight.sh', import.meta.url
))
const run = (metadata, failed = '0') => spawnSync('bash', ['-c', `
  source "$CHECK_SCRIPT"
  mysql_mock() {
    case "\${!#}" in
      *"COUNT(*) FROM flyway_schema_history"*) printf '%s\\n' "$FAILED_ROWS" ;;
      *) printf '%s\\n' "$DB_METADATA" ;;
    esac
  }
  MYSQL_BIN=mysql_mock
  check_local_database_preflight
`], {
  encoding: 'utf8',
  env: { ...process.env, CHECK_SCRIPT: script, DB_METADATA: metadata, FAILED_ROWS: failed }
})
const metadata = (major = '8', engine = 'InnoDB', history = '1') => [
  `major\t${major}`,
  `release\t${major}.4.7`,
  ...['columns_priv', 'db', 'global_grants', 'procs_priv', 'tables_priv', 'user']
    .map((table) => `grant:${table}\t${table === 'db' ? engine : 'InnoDB'}`),
  'system:func\tInnoDB',
  'host-shape\t2',
  `history-exists\t${history}`
].join('\n')

test('startup database preflight allows consistent grant tables and clean migration history', () => {
  const result = run(metadata())
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /PASS/)
})

test('MySQL 8 MyISAM grant-table regression stops before migration or Java startup', () => {
  const result = run(metadata('8', 'MyISAM'))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /db=MyISAM/)
  assert.match(result.stderr, /Do not repair Flyway/)
  assert.doesNotMatch(result.stdout, /PASS/)
})

test('InnoDB alone cannot hide the old MySQL 8.4 grant-table definitions', () => {
  const result = run(metadata().replace('host-shape\t2', 'host-shape\t0'))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /definitions are outdated/)
  assert.doesNotMatch(result.stdout, /PASS/)
})

test('MySQL 8 nontransactional function tables and missing system metadata fail closed', () => {
  for (const input of [
    metadata().replace('system:func\tInnoDB', 'system:func\tMyISAM'),
    metadata().replace('system:func\tInnoDB\n', ''),
    metadata().replace('host-shape\t2\n', ''),
    metadata().replace('release\t8.4.7', 'release\t5.7.44'),
    metadata().replace('host-shape\t2', 'host-shape\t3')
  ]) {
    const result = run(input)
    assert.equal(result.status, 1, result.stdout)
    assert.match(result.stderr, /BLOCKED/)
  }
})

test('failed, unreadable and malformed metadata never allows startup', () => {
  for (const [input, failed] of [
    [metadata(), '1'], [metadata(), 'unknown'], [metadata(), ''],
    [metadata('unknown'), '0'], ['major\t8\nhistory-exists\t1', '0'],
    [metadata().replace('grant:db\tInnoDB', 'grant:db\tInnoDB\textra'), '0'],
    [metadata().replace('grant:db\tInnoDB\n', ''), '0'],
    [metadata().replace('grant:db\tInnoDB', 'grant:user\tInnoDB'), '0']
  ]) {
    const result = run(input, failed)
    assert.equal(result.status, 1, `${input}: ${result.stdout}`)
    assert.match(result.stderr, /BLOCKED/)
  }
})

test('new empty business schema remains eligible for normal Flyway initialization', () => {
  const result = run(metadata('8', 'InnoDB', '0'))
  assert.equal(result.status, 0, result.stderr)
})

test('legacy MySQL 5 grant tables are not misclassified as the observed MySQL 8 upgrade defect', () => {
  const result = run(metadata('5', 'MyISAM'))
  assert.equal(result.status, 0, result.stderr)
})

test('preflight contains only metadata SELECTs and runs before license lookup or launch', () => {
  const source = fs.readFileSync(new URL(
    '../../../../cfor/cfor-admin/scripts/check-database-preflight.sh', import.meta.url
  ), 'utf8')
  assert.doesNotMatch(source, /\b(ALTER|UPDATE|DELETE|DROP|TRUNCATE|REPAIR|INSERT)\b/)
  assert.doesNotMatch(source, /--password|-p"\$/)
  const startup = fs.readFileSync(new URL(
    '../../../../cfor/cfor-admin/scripts/start-501-local.sh', import.meta.url
  ), 'utf8')
  assert.ok(startup.indexOf('check-local-database-preflight.sh') <
    startup.indexOf('CFOR_FRAMEWORK_OFFLINE_LICENSE_CODE='))
  assert.ok(startup.indexOf('check-local-database-preflight.sh') < startup.indexOf('exec "$JAVA_HOME/bin/java"'))
})

test('deployment preflight requires an explicit database and user instead of local credentials', () => {
  const deploymentScript = fileURLToPath(new URL(
    '../../../../cfor/cfor-admin/scripts/check-database-preflight.sh', import.meta.url
  ))
  const result = spawnSync('bash', [deploymentScript], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, CFOR_DB_PORT: '3306' }
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /specify database, user/)
  for (const port of ['0', '65536', 'abc']) {
    const invalid = spawnSync('bash', [deploymentScript], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, CFOR_DB_NAME: 'test', CFOR_DB_USER: 'operator', CFOR_DB_PORT: port }
    })
    assert.equal(invalid.status, 1)
    assert.match(invalid.stderr, /valid database port/)
  }
})
