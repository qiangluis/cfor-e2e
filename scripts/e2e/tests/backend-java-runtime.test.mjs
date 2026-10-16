import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const startup = fileURLToPath(new URL(
  '../../../../cfor/cfor-admin/scripts/start-501-local.sh', import.meta.url
))

for (const version of ['1.8.0_441', '16.0.2', '21.0.8', 'unknown']) {
  test(`local startup rejects Java ${version} before database or license access`, (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfor-java-runtime-'))
    t.after(() => fs.rmSync(home, { recursive: true, force: true }))
    fs.mkdirSync(path.join(home, 'bin'))
    fs.writeFileSync(path.join(home, 'bin/java'),
      `#!/bin/sh\nprintf '%s\\n' 'openjdk version "${version}"' >&2\n`, { mode: 0o755 })
    const result = spawnSync('bash', [startup], {
      encoding: 'utf8',
      env: { ...process.env, JAVA_HOME: home, CFOR_MYSQL_BIN: '/missing/mysql' }
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Java 17/)
    assert.doesNotMatch(result.stderr, /missing\/mysql|数据库|离线授权码/)
    assert.doesNotMatch(result.stdout, /启动 cfor-server|运行包快照/)
  })
}

test('local startup rejects an invalid explicit JAVA_HOME without falling back to Java 21', () => {
  const result = spawnSync('bash', [startup], {
    encoding: 'utf8', env: { ...process.env, JAVA_HOME: '/missing/cfor-java' }
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Java 17/)
  assert.doesNotMatch(result.stdout, /启动 cfor-server/)
})

test('local startup resolves Java 17 when JAVA_HOME is unset and validates before database access', () => {
  const source = fs.readFileSync(startup, 'utf8')
  assert.match(source, /\/usr\/libexec\/java_home -v 17/)
  assert.match(source, /\[ "\$JAVA_MAJOR" != "17" \]/)
  assert.ok(source.indexOf('JAVA_MAJOR" != "17"') <
    source.indexOf('check-local-database-preflight.sh'))
  assert.doesNotMatch(source, /static-openjdk-21|DEFAULT_JAVA_HOME/)
})
