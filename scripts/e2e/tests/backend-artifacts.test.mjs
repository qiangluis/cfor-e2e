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
  fs.mkdirSync(payload)
  fs.writeFileSync(path.join(payload, 'build.txt'), 'current build')
  execFileSync('zip', ['-q', moduleJar, 'build.txt'], { cwd: payload })
  const serverDir = path.join(root, 'cfor-server/target')
  fs.mkdirSync(serverDir, { recursive: true })
  const packageDir = path.join(root, 'package/BOOT-INF/lib')
  fs.mkdirSync(packageDir, { recursive: true })
  fs.copyFileSync(moduleJar, path.join(packageDir, path.basename(moduleJar)))
  const serverJar = path.join(serverDir, 'cfor-server-4.jar')
  execFileSync('zip', ['-q', '-r', serverJar, 'BOOT-INF'], { cwd: path.join(root, 'package') })
  const run = (jar = serverJar) => spawnSync('bash', [script, jar], { encoding: 'utf8' })
  return { root, run, moduleDir, moduleJar, payload }
}

test('local startup accepts identical embedded reactor artifacts', (t) => {
  const { run } = fixture(t)
  const result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /PASS.*1.*reactor/)
})

test('local startup rejects an older embedded module before restarting', (t) => {
  const { run, moduleJar, payload } = fixture(t)
  fs.writeFileSync(path.join(payload, 'build.txt'), 'newer build')
  execFileSync('zip', ['-q', moduleJar, 'build.txt'], { cwd: payload })
  const result = run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /FAIL.*不一致/)
  assert.match(result.stderr, /-pl cfor-server -am/)
})

test('local startup rejects compiled classes not yet repackaged', (t) => {
  const { run, moduleDir } = fixture(t)
  const classes = path.join(moduleDir, 'classes')
  fs.mkdirSync(classes)
  const compiled = path.join(classes, 'Example.class')
  fs.writeFileSync(compiled, 'new class')
  const future = new Date(Date.now() + 10000)
  fs.utimesSync(compiled, future, future)
  const result = run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /尚未重新 package/)
})

test('local startup rejects a missing server artifact', (t) => {
  const { root, run } = fixture(t)
  const result = run(path.join(root, 'missing.jar'))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /未找到主 JAR/)
})
