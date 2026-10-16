import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const verifier = fileURLToPath(new URL(
  '../../../../cfor/cfor-admin/scripts/verify-local-server-artifacts.sh', import.meta.url
))

const classBytes = Buffer.from('cafebabe0000003d', 'hex')
const migrationDirectories = ['migration', 'post-start-migration', 'feature-migration']

function writeFixtureFile (file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

function assertPass (result) {
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /PASS 主 JAR 内嵌的 1 个本仓模块、2 个 class 和迁移与 reactor\/源码一致/)
}

function fixture (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfor-artifacts-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const scripts = path.join(root, 'scripts')
  fs.mkdirSync(scripts)
  const script = path.join(scripts, 'verify.sh')
  fs.copyFileSync(verifier, script)
  const moduleDir = path.join(root, 'cfor-module-wms/cfor-module-wms-biz/target')
  fs.mkdirSync(moduleDir, { recursive: true })
  const moduleJar = path.join(moduleDir, 'cfor-module-wms-biz-test.jar')
  const payload = path.join(root, 'payload')
  const moduleClassEntry = 'tech/cfor17/Example.class'
  const moduleClass = path.join(moduleDir, 'classes', moduleClassEntry)
  writeFixtureFile(moduleClass, classBytes)
  writeFixtureFile(path.join(payload, moduleClassEntry), classBytes)
  writeFixtureFile(path.join(payload, 'build.txt'), 'current build')
  execFileSync('zip', ['-q', '-r', moduleJar, '.'], { cwd: payload })
  const serverDir = path.join(root, 'cfor-server/target')
  fs.mkdirSync(serverDir, { recursive: true })
  const packageDir = path.join(root, 'package')
  const moduleEntry = path.join(packageDir, 'BOOT-INF/lib', path.basename(moduleJar))
  fs.mkdirSync(path.dirname(moduleEntry), { recursive: true })
  fs.copyFileSync(moduleJar, moduleEntry)
  const serverClassEntry = 'BOOT-INF/classes/tech/cfor17/server/CforServerApplication.class'
  const serverClass = path.join(serverDir, 'classes/tech/cfor17/server/CforServerApplication.class')
  writeFixtureFile(serverClass, classBytes)
  writeFixtureFile(path.join(packageDir, serverClassEntry), classBytes)
  const migrations = migrationDirectories.map((directory) => {
    const relative = `db/${directory}/V202610130000__artifact_test.sql`
    const source = path.join(root, 'cfor-server/src/main/resources', relative)
    const entry = `BOOT-INF/classes/${relative}`
    const contents = `SELECT '${directory}';\n`
    writeFixtureFile(source, contents)
    writeFixtureFile(path.join(packageDir, entry), contents)
    return { directory, source, entry }
  })
  const serverJar = path.join(serverDir, 'cfor-server-4.jar')
  execFileSync('zip', ['-q', '-r', serverJar, 'BOOT-INF'], { cwd: packageDir })
  const run = (jar = serverJar) => spawnSync('bash', [script, jar], { encoding: 'utf8' })
  return { root, run, moduleDir, moduleJar, moduleClass, payload, serverClass, serverJar, migrations }
}

test('local startup accepts identical embedded artifacts, classes and migrations', (t) => {
  const { run } = fixture(t)
  assertPass(run())
})

test('local startup rejects an older embedded module before restarting', (t) => {
  const { root, run, moduleJar, payload } = fixture(t)
  fs.writeFileSync(path.join(payload, 'build.txt'), 'newer build')
  execFileSync('zip', ['-q', moduleJar, 'build.txt'], { cwd: payload })
  const result = run()
  assert.equal(result.status, 1)
  assert(result.stderr.includes(`FAIL 内嵌包与 reactor 产物不一致：${path.relative(root, moduleJar)}`),
    result.stderr)
  assert.match(result.stderr, /-pl cfor-server -am/)
})

test('local startup accepts identical module and server classes with future mtimes', (t) => {
  const { run, moduleClass, serverClass } = fixture(t)
  const future = new Date(Date.now() + 60000)
  for (const compiled of [moduleClass, serverClass]) fs.utimesSync(compiled, future, future)
  assertPass(run())
})

test('local startup rejects different module class contents regardless of mtime', (t) => {
  const { root, run, moduleClass } = fixture(t)
  fs.writeFileSync(moduleClass, Buffer.from('cafebabe0000003e', 'hex'))
  const past = new Date(0)
  fs.utimesSync(moduleClass, past, past)
  const result = run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /FAIL JAR 中的 class 与 reactor classes 不一致/)
  assert(result.stderr.includes(path.relative(root, moduleClass)), result.stderr)
  assert.match(result.stderr, /-pl cfor-server -am/)
})

test('local startup rejects a compiled module class missing from its JAR', (t) => {
  const { root, run, moduleDir } = fixture(t)
  const compiled = path.join(moduleDir, 'classes/tech/cfor17/Unpackaged.class')
  writeFixtureFile(compiled, classBytes)
  const result = run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /FAIL class 缺失或校验期间发生变化/)
  assert(result.stderr.includes(path.relative(root, compiled)), result.stderr)
})

for (const directory of migrationDirectories) {
  test(`local startup rejects duplicate ${directory} versions even when the JAR matches source`, (t) => {
    const { root, run, serverJar } = fixture(t)
    const relative = `db/${directory}/V202610130000__duplicate.sql`
    const contents = 'SELECT 2;\n'
    writeFixtureFile(path.join(root, 'cfor-server/src/main/resources', relative), contents)
    const packageDir = path.join(root, 'package')
    const entry = `BOOT-INF/classes/${relative}`
    writeFixtureFile(path.join(packageDir, entry), contents)
    execFileSync('zip', ['-q', serverJar, entry], { cwd: packageDir })
    const result = run()
    assert.equal(result.status, 1)
    assert.match(result.stderr, /FAIL Flyway 版本重复/)
    assert.match(result.stderr, /仅重新打包不能解决/)
    assert.ok(result.stderr.includes(relative), result.stderr)
  })

  test(`local startup rejects a ${directory} SQL file missing from the server JAR`, (t) => {
    const { root, run, serverJar, migrations } = fixture(t)
    const migration = migrations.find((item) => item.directory === directory)
    execFileSync('zip', ['-q', '-d', serverJar, migration.entry])
    const result = run()
    assert.equal(result.status, 1)
    assert.match(result.stderr, /FAIL 迁移未进入主 JAR/)
    assert(result.stderr.includes(path.relative(root, migration.source)), result.stderr)
    assert.match(result.stderr, /-pl cfor-server -am/)
  })

  test(`local startup rejects different ${directory} SQL contents`, (t) => {
    const { root, run, migrations } = fixture(t)
    const migration = migrations.find((item) => item.directory === directory)
    fs.writeFileSync(migration.source, `SELECT 'changed ${directory}';\n`)
    const result = run()
    assert.equal(result.status, 1)
    assert.match(result.stderr, /FAIL 主 JAR 中的迁移与源码不一致/)
    assert(result.stderr.includes(path.relative(root, migration.source)), result.stderr)
    assert.match(result.stderr, /-pl cfor-server -am/)
  })
}

test('local startup rejects different main server class contents regardless of mtime', (t) => {
  const { root, run, serverClass } = fixture(t)
  fs.writeFileSync(serverClass, Buffer.from('cafebabe0000003e', 'hex'))
  const past = new Date(0)
  fs.utimesSync(serverClass, past, past)
  const result = run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /FAIL JAR 中的 class 与 reactor classes 不一致/)
  assert(result.stderr.includes(path.relative(root, serverClass)), result.stderr)
})

test('local startup rejects a missing server artifact', (t) => {
  const { root, run } = fixture(t)
  const result = run(path.join(root, 'missing.jar'))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /未找到主 JAR/)
})
