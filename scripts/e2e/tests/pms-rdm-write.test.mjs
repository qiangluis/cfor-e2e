import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  RDM_CASES,
  RDM_PREFIX,
  expectBusinessFailure,
  assertRdmLocalTarget,
  assertRdmPage,
  createRdmFixture,
  createPmProject,
  createRdmMaterial,
  rdmMaterialCode
} from '../fixtures/rdm.mjs'

const record = () => ({ checks: [], evidence: [], notes: [] })

test('RDM write fixture covers exactly RDM001-RDM006 and keeps the isolated prefix', () => {
  assert.deepEqual([...RDM_CASES].sort(), [
    'RDM-001',
    'RDM-002',
    'RDM-003',
    'RDM-004',
    'RDM-005',
    'RDM-006'
  ])
  assert.equal(RDM_PREFIX, 'E2E-RDM')
})

test('RDM fixture is limited to the local tenant and only reads the database', () => {
  const source = fs.readFileSync(new URL('../fixtures/rdm.mjs', import.meta.url), 'utf8')
  assert.match(source, /tenant_id=1/)
  assert.match(source, /runReadOnlySql/)
  assert.doesNotMatch(source, /(?:UPDATE\s+(?:FROM|INTO|SET)|INSERT\s+INTO|DELETE\s+FROM|TRUNCATE\s+TABLE)\b/i)
  assert.doesNotMatch(source, /\/(?:delete|remove|reset)(?:[/?'"`]|$)/i)
})

test('expectBusinessFailure does not treat a business success as an expected validation failure', async () => {
  const checks = []
  const api = {
    async request () {
      return { code: 0, data: true }
    }
  }
  await assert.rejects(
    () => expectBusinessFailure({
      api,
      method: 'PUT',
      path: '/pm/task/block',
      body: {},
      caseRecord: { checks },
      name: 'expected failure'
    }),
    /预期业务失败但接口成功/
  )
  assert.equal(checks[0].passed, false)
})

test('RDM fixture does not use shared catalog or shared helper files', () => {
  const source = fs.readFileSync(new URL('../fixtures/rdm.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /catalog\.json/)
  assert.doesNotMatch(source, /scripts\/e2e\/lib\//)
})

test('RDM resumed task SQL proves each cleared field without trailing empty TSV cells', () => {
  const source = fs.readFileSync(new URL('../fixtures/rdm.mjs', import.meta.url), 'utf8')
  for (const field of ['block_reason', 'block_party', 'release_condition']) {
    assert.ok(source.includes(`LENGTH(COALESCE(${field},''))`))
  }
  assert.match(source, /\.every\(\(value\) => value === '0'\)/)
})

test('RDM writes refuse production, a different tenant and unexpected local ports', () => {
  const target = {
    target: 'local', tenantId: '1',
    apiBase: 'http://127.0.0.1:48083', webBase: 'http://127.0.0.1:9151'
  }
  assert.doesNotThrow(() => assertRdmLocalTarget(target))
  for (const invalid of [
    { target: 'production' },
    { tenantId: '2' },
    { apiBase: 'https://example.com:48083' },
    { apiBase: 'http://127.0.0.1:48084' },
    { webBase: 'http://127.0.0.1:9152' }
  ]) {
    assert.throws(() => assertRdmLocalTarget({ ...target, ...invalid }), /^Error: BLOCKED:/)
  }
})

test('fixture initialization runs safety first and resolves projectType without local binding shadowing', async () => {
  const calls = []
  const caseRecord = record()
  const api = {
    async getBusiness (path) {
      calls.push(path)
      if (path === '/system/user/profile/get') {
        return { code: 0, data: { id: '1', username: 'admin', nickname: 'E2E' } }
      }
      return { code: 0, data: [{ configCode: 'STANDARD', status: 'ENABLED', versionNo: 1 }] }
    }
  }
  const fixture = await createRdmFixture({
    api, caseRecord, caseId: 'RDM-001',
    writeSafety: async () => calls.push('safety')
  })
  assert.deepEqual(calls, [
    'safety', '/system/user/profile/get',
    '/pm/modeling/list?configKey=projectType&status=ENABLED'
  ])
  assert.equal(fixture.ownerId, '1')
  assert.equal(fixture.projectType, 'STANDARD')
  assert.match(fixture.tag, /^E2E-RDM-RDM001-/)
  assert.equal(caseRecord.fixtures.tag, fixture.tag)
})

test('fixture safety failure stops before any business API', async () => {
  let calls = 0
  await assert.rejects(() => createRdmFixture({
    caseId: 'RDM-003',
    caseRecord: record(),
    api: { getBusiness: async () => { calls++; return {} } },
    writeSafety: async () => { throw new Error('BLOCKED: unsafe local database') }
  }), /unsafe local database/)
  assert.equal(calls, 0)
})

test('PM project creation refuses missing hard-coded base rules without writing shared modeling or handovers', async () => {
  const calls = []
  await assert.rejects(() => createPmProject({
    fixture: { tag: 'E2E-RDM-test' },
    api: {
      getBusiness: async (path) => {
        calls.push(path)
        return { code: 0, data: [{ configCode: 'PROJECT_NO', status: 'ENABLED' }] }
      },
      postBusiness: async () => { throw new Error('unexpected write') },
      putBusiness: async () => { throw new Error('unexpected write') }
    }
  }), /BLOCKED:.*PB-001.*PB-005/)
  assert.deepEqual(calls, ['/pm/modeling/list?configKey=projectBase&status=ENABLED'])
})

test('PM project fixture consumes formal enabled rules and keeps large IDs as strings', async () => {
  const calls = []
  const projectId = '2107683336325099521'
  const handoverId = '2107683336325099501'
  const result = await createPmProject({
    fixture: { tag: 'E2E-RDM-test', projectType: 'STANDARD', ownerId: '1' },
    api: {
      getBusiness: async () => ({
        code: 0,
        data: ['PB-001', 'PB-002', 'PB-003', 'PB-004', 'PB-005'].map(
          (configCode) => ({ configCode, status: 'ENABLED' }))
      }),
      postBusiness: async (path, body) => {
        calls.push({ path, body })
        return { code: 0, data: handoverId }
      },
      putBusiness: async (path, body) => {
        calls.push({ path, body })
        return { code: 0, data: path === '/pm/handover/review' ? projectId : true }
      }
    }
  })
  assert.deepEqual(result, { projectId, handoverId })
  assert.equal(calls[0].body.sourceType, 'MANUAL')
  assert.equal(calls[0].body.sourceBusinessNo, 'E2E-RDM-test')
  assert.equal(calls[0].body.projectName, 'E2E-RDM-test-PM')
  assert.equal(calls[2].body.decision, 'APPROVE')
})

test('RDM material and revision codes are stable, distinct and no longer than 32 characters', () => {
  const tag = `E2E-RDM-${'long-token-'.repeat(20)}`
  const parent = rdmMaterialCode(tag, 'PARENT')
  const component = rdmMaterialCode(tag, 'COMPONENT')
  assert.equal(parent, rdmMaterialCode(tag, 'PARENT'))
  assert.notEqual(parent, component)
  assert.notEqual(parent, rdmMaterialCode(`${tag}-next`, 'PARENT'))
  for (const code of [parent, component, `${parent}-R1`, `${component}-R1`]) {
    assert.match(code, /^E2E-RDM-[PC]-[a-f0-9]{16}/)
    assert.ok(code.length <= 32)
  }
})

test('RDM material writes supply purchase lead/buffer requirements and preserve the full isolation token', async () => {
  const fixture = { tag: 'E2E-RDM-RDM005-long-fixture-token' }
  const caseRecord = record()
  let body
  const material = await createRdmMaterial({
    fixture, caseRecord, suffix: 'PARENT', unit: { id: '12', name: 'kg' },
    api: {
      postBusiness: async (path, request) => {
        assert.equal(path, '/mes/basMaterial/add')
        body = request
        return { success: true, code: 200, data: '2107683336325099521' }
      },
      getBusiness: async () => ({ success: true, code: 200, data: body })
    }
  })
  assert.equal(body.leadTime, 1)
  assert.equal(body.bufferTime, 0)
  assert.equal(body.source, 'mixed')
  assert.equal(body.remark, fixture.tag)
  assert.match(body.name, /long-fixture-token/)
  assert.ok(body.code.length <= 32)
  assert.equal(material.id, '2107683336325099521')
  assert.ok(caseRecord.checks.every((check) => check.passed))
})

test('RDM material readback rejects ownership mismatch', async () => {
  await assert.rejects(() => createRdmMaterial({
    fixture: { tag: 'E2E-RDM-owned' }, caseRecord: record(), suffix: 'COMPONENT',
    unit: { id: '12' },
    api: {
      postBusiness: async () => ({ code: 0, data: '100' }),
      getBusiness: async () => ({ code: 0, data: { code: 'shared', remark: 'shared', unitId: '12' } })
    }
  }), /所有权校验/)
})

for (const payload of [
  { code: 500, data: null, msg: '系统异常' },
  { code: 500, data: null, msg: '采购类物料必须填写提前期' },
  { code: 403, data: null, msg: '无权限' },
  { code: 404, data: null, msg: '接口不存在' },
  { code: 400, data: null, msg: 'SQL Exception' }
]) {
  test(`expected validation failure rejects server/routing/auth/SQL errors: ${payload.code} ${payload.msg}`, async () => {
    const caseRecord = record()
    const expectedPaths = new Set()
    await assert.rejects(() => expectBusinessFailure({
      api: { request: async () => payload }, method: 'POST', path: '/plm/rdm/record/create',
      caseRecord, expectedPaths, name: 'validation'
    }), /非预期业务校验失败/)
    assert.equal(caseRecord.checks[0].passed, false)
    assert.equal(expectedPaths.size, 0)
  })
}

test('only the exact expected business code is accepted as a negative assertion', async () => {
  const expectedPaths = new Set()
  const caseRecord = record()
  const payload = { code: 2003005007, data: null, msg: '研发领料必须关联试制批次' }
  await expectBusinessFailure({
    api: { request: async () => payload }, method: 'POST', path: '/plm/rdm/record/create',
    caseRecord, expectedPaths, name: 'validation', expectedCode: 2003005007, expectedMessage: /试制批次/
  })
  assert.equal(caseRecord.checks[0].passed, true)
  assert.ok(expectedPaths.has('/plm/rdm/record/create'))
  await assert.rejects(() => expectBusinessFailure({
    api: { request: async () => payload }, method: 'POST', path: '/plm/rdm/record/create',
    caseRecord: record(), name: 'validation', expectedCode: 2003005008
  }), /非预期业务校验失败/)
})

test('missing task release condition accepts the exact Bean Validation response only', async () => {
  const expectedPaths = new Set()
  const options = {
    method: 'PUT', path: '/pm/task/block', body: { taskId: '9', reason: 'blocked' },
    name: 'release condition required', expectedCode: 400,
    expectedMessage: /must not be blank|不能为空/i
  }
  const caseRecord = record()
  await expectBusinessFailure({
    ...options, caseRecord, expectedPaths,
    api: { request: async () => ({ code: 400, data: null, msg: '请求参数不正确:must not be blank' }) }
  })
  assert.equal(caseRecord.checks[0].passed, true)
  assert.ok(expectedPaths.has('/pm/task/block'))
  for (const payload of [
    { code: 400, data: null, msg: '请求参数不正确:must not be null' },
    { code: 500, data: null, msg: '请求参数不正确:must not be blank' }
  ]) {
    await assert.rejects(() => expectBusinessFailure({
      ...options, caseRecord: record(),
      api: { request: async () => payload }
    }), /非预期业务校验失败/)
  }
})

test('RDM pagination must include the owned row and actual catalog fields', async () => {
  for (const list of [[], [{ id: '9' }], [{ id: '11', planId: '1', runId: '2' }]]) {
    const caseRecord = record()
    await assertRdmPage({
      api: { getBusiness: async () => ({ code: 0, data: { total: list.length, list } }) },
      caseRecord, path: '/plm/rdm/record/page?pageNo=1&pageSize=100', label: 'approval',
      id: '9', fields: ['planId', 'runId']
    })
    assert.equal(caseRecord.checks[1].passed, false)
  }
})
