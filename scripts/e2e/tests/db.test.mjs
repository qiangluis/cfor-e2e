import test from 'node:test'
import assert from 'node:assert/strict'
import { assertWriteTestSnapshot } from '../lib/db.mjs'

const idle = [
  ['failed-migrations', '0'],
  ['enabled-jobs', '0'],
  ['active-triggers', '0']
]

test('write preflight only accepts complete zero-count database evidence', () => {
  assert.doesNotThrow(() => assertWriteTestSnapshot(idle))
  assert.throws(() => assertWriteTestSnapshot([]), /^Error: BLOCKED:/)
  assert.throws(() => assertWriteTestSnapshot([
    ['failed-migrations', 'invalid'], ...idle.slice(1)
  ]), /^Error: BLOCKED:/)
})

for (const tag of ['failed-migrations', 'enabled-jobs', 'active-triggers']) {
  test(`${tag} prevents acceptance fixture writes`, () => {
    assert.throws(() => assertWriteTestSnapshot(
      idle.map(([key, value]) => [key, key === tag ? '1' : value])
    ), /^Error: BLOCKED:/)
  })
}
