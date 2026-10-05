import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  checkpointScope,
  implementationFingerprint,
  resumableCases
} from '../lib/checkpoint.mjs'

const input = () => ({
  environment: ['local', 'http://127.0.0.1:9151', '1', 'admin'],
  catalog: { version: 'same-version', cases: [{ id: 'PROC-016', status: 'READY' }] },
  implementation: 'initial-script-digest'
})

test('checkpoint scope changes when case status or assertions change without a version bump', () => {
  const original = input()
  const partial = input()
  partial.catalog.cases[0].status = 'PARTIAL'
  const assertions = input()
  assertions.catalog.cases[0].assertions = ['real invoice review required']
  assert.notEqual(checkpointScope(original), checkpointScope(partial))
  assert.notEqual(checkpointScope(original), checkpointScope(assertions))
  assert.match(checkpointScope(original), /^v2-[0-9a-f]{24}$/)
})

test('checkpoint scope is stable but differs for environment or implementation changes', () => {
  assert.equal(checkpointScope(input()), checkpointScope(input()))
  const environment = input()
  environment.environment[2] = '2'
  const implementation = input()
  implementation.implementation = 'changed-script-digest'
  assert.notEqual(checkpointScope(input()), checkpointScope(environment))
  assert.notEqual(checkpointScope(input()), checkpointScope(implementation))
})

test('only current complete runnable cases can reuse passed checkpoints', () => {
  const definitions = new Map([
    ['READY', { status: 'READY' }],
    ['DEFAULT', {}],
    ['PARTIAL', { status: 'PARTIAL' }],
    ['DESIGNED', { status: 'DESIGNED' }],
    ['BLOCKED', { status: 'BLOCKED' }]
  ])
  assert.deepEqual([...resumableCases(
    ['READY', 'DEFAULT', 'PARTIAL', 'DESIGNED', 'BLOCKED', 'REMOVED'], definitions
  )], ['READY', 'DEFAULT'])
  assert.equal(resumableCases(null, definitions).size, 0)
})

test('fingerprint includes runtime helpers and ignores local secrets and evidence', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfor-checkpoint-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const directory of ['config', 'lib', 'fixtures', 'suites']) {
    fs.mkdirSync(path.join(root, directory))
    fs.writeFileSync(path.join(root, directory, 'runtime.mjs'), 'export const version = 1\n')
  }
  fs.writeFileSync(path.join(root, 'runner.mjs'), 'export const runner = 1\n')
  const initial = implementationFingerprint(root)
  fs.writeFileSync(path.join(root, 'config/local.env'), 'CFOR_PASSWORD=not-a-real-secret\n')
  fs.writeFileSync(path.join(root, 'lib/result.json'), '{"passed":true}')
  assert.equal(implementationFingerprint(root), initial)
  fs.writeFileSync(path.join(root, 'fixtures/runtime.mjs'), 'export const version = 2\n')
  assert.notEqual(implementationFingerprint(root), initial)
  const fixtureChange = implementationFingerprint(root)
  fs.writeFileSync(path.join(root, 'lib/chrome-macos.sh'), '#!/bin/sh\n')
  assert.notEqual(implementationFingerprint(root), fixtureChange)
})
