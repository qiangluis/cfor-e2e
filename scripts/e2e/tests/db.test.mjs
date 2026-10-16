import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { assertWriteTestSnapshot } from '../lib/db.mjs'

const idle = [
  ['failed-migrations', '0'],
  ['enabled-jobs', '0'],
  ['active-triggers', '0'],
  ['active-database-writers', '0']
]

test('write preflight only accepts complete zero-count database evidence', () => {
  assert.doesNotThrow(() => assertWriteTestSnapshot(idle))
  assert.throws(() => assertWriteTestSnapshot([]), /^Error: BLOCKED:/)
  assert.throws(() => assertWriteTestSnapshot(null), /^Error: BLOCKED:/)
  assert.throws(() => assertWriteTestSnapshot([...idle, idle[0]]), /^Error: BLOCKED:/)
  assert.throws(() => assertWriteTestSnapshot(
    idle.map((row, index) => index === 0 ? [...row, 'unexpected'] : row)
  ), /^Error: BLOCKED:/)
  assert.throws(() => assertWriteTestSnapshot([
    ['failed-migrations', 'invalid'], ...idle.slice(1)
  ]), /^Error: BLOCKED:/)
})

for (const tag of ['failed-migrations', 'enabled-jobs', 'active-triggers', 'active-database-writers']) {
  test(`${tag} prevents acceptance fixture writes`, () => {
    assert.throws(() => assertWriteTestSnapshot(
      idle.map(([key, value]) => [key, key === tag ? '1' : value])
    ), /^Error: BLOCKED:/)
  })
}

test('clean Flyway history cannot hide an in-flight database writer', () => {
  assert.throws(() => assertWriteTestSnapshot(idle.slice(0, 3)), /active-database-writers/)
  for (const value of ['1', '8', 'unknown', '-1', '']) {
    assert.throws(() => assertWriteTestSnapshot(
      idle.map(([key, count]) => [key, key === 'active-database-writers' ? value : count])
    ), /active-database-writers/)
  }
})

test('writer preflight is read-only, database-scoped and excludes its own connection', () => {
  const source = fs.readFileSync(new URL('../lib/db.mjs', import.meta.url), 'utf8')
  const query = source.match(/SELECT 'active-database-writers'[\s\S]*?REGEXP '[^']*'/)?.[0]
  assert.ok(query)
  assert.match(query, /FROM information_schema\.PROCESSLIST/)
  assert.match(query, /DB = DATABASE\(\) AND ID <> CONNECTION_ID\(\)/)
  assert.match(query, /COMMAND <> 'Sleep'/)
  assert.match(query, /\^\(INSERT\|UPDATE\|DELETE\|REPLACE\|ALTER\|CREATE\|DROP\|TRUNCATE\|RENAME\|LOAD\)/)
})
