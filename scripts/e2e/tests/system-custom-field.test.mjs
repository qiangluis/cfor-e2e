import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertCustomFieldWriteScope,
  cases,
  cleanupCustomField,
  catalogCheck,
  catalogConclusion,
  dataOf,
  evaluateObjectPlacements,
  evaluateRuntimeSnapshot,
  initializeCatalogChecks
} from '../suites/system-custom-field.mjs'

test('PB040 suite keeps all three catalog cases wired to the dedicated suite', () => {
  assert.deepEqual(cases, ['PB040-001', 'PB040-002', 'PB040-003'])
})

test('custom-field dataOf unwraps envelopes and preserves already-unwrapped values', () => {
  assert.equal(dataOf({ code: 0, data: 123, msg: 'success' }), 123)
  assert.deepEqual(dataOf({ code: 0, data: { status: 'DRAFT' }, msg: 'success' }), {
    status: 'DRAFT'
  })
  assert.deepEqual(dataOf({ code: 0, data: [{ action: 'SUBMIT' }], msg: 'success' }), [
    { action: 'SUBMIT' }
  ])

  const alreadyUnwrapped = { status: 'DRAFT', data: 'business-data' }
  assert.strictEqual(dataOf(alreadyUnwrapped), alreadyUnwrapped)
  assert.equal(dataOf({ code: 0, data: null, msg: 'success' }), null)
})

test('custom-field cleanup rejects pending publish and deletes the resulting draft', async () => {
  let status = 'PENDING_PUBLISH'
  const calls = []
  const fixture = {
    createdThisRun: true,
    tenantId: '1',
    runId: 'run-1',
    fieldId: 123,
    fieldCode: 'E2E_PB040_TEST',
    marker: 'E2E_PB040_TEST owned PB040-002'
  }
  const api = {
    getBusiness: async (pathname) => {
      calls.push(['getBusiness', pathname])
      if (pathname.includes('/impact?')) return { code: 0, data: { valueCount: 0 }, msg: 'success' }
      return {
        code: 0,
        data: {
          id: 123,
          fieldCode: fixture.fieldCode,
          description: fixture.marker,
          referenceCount: 0,
          status,
          currentVersion: 0
        },
        msg: 'success'
      }
    },
    postBusiness: async (pathname, body) => {
      calls.push(['postBusiness', pathname, body])
      assert.equal(pathname, '/system/custom-field/review-publish')
      assert.equal(body.decision, 'REJECT')
      status = 'DRAFT'
      return { code: 0, data: true, msg: 'success' }
    },
    get: async (pathname) => {
      calls.push(['get', pathname])
      return { code: 1002034000, msg: 'not found' }
    },
    deleteBusiness: async (pathname) => {
      calls.push(['deleteBusiness', pathname])
      assert.equal(status, 'DRAFT')
      return { code: 0, data: true, msg: 'success' }
    }
  }
  const caseRecord = { notes: [], checks: [] }

  await cleanupCustomField({ api, fieldId: 123, fixture, caseRecord })

  assert.deepEqual(calls.map(([method, pathname]) => [method, pathname]), [
    ['getBusiness', '/system/custom-field/get?id=123'],
    ['getBusiness', '/system/custom-field/impact?id=123'],
    ['postBusiness', '/system/custom-field/review-publish'],
    ['getBusiness', '/system/custom-field/get?id=123'],
    ['getBusiness', '/system/custom-field/impact?id=123'],
    ['deleteBusiness', '/system/custom-field/delete?id=123'],
    ['get', '/system/custom-field/get?id=123']
  ])
  assert.deepEqual(caseRecord.notes, [])
  assert.equal(fixture.cleanup, 'DELETED_VERIFIED')
  assert.equal(caseRecord.checks.at(-1).passed, true)
})

test('custom-field cleanup creates a draft from a published field and records cleanup failures', async () => {
  let status = 'PUBLISHED'
  const calls = []
  const fixture = {
    createdThisRun: true,
    tenantId: '1',
    runId: 'run-1',
    fieldId: 456,
    fieldCode: 'E2E_PB040_TEST',
    marker: 'E2E_PB040_TEST owned PB040-002'
  }
  const api = {
    getBusiness: async (pathname) => {
      calls.push(['getBusiness', pathname])
      if (pathname.includes('/impact?')) return { code: 0, data: { valueCount: 0 }, msg: 'success' }
      return {
        code: 0,
        data: {
          id: 456,
          fieldCode: fixture.fieldCode,
          description: fixture.marker,
          referenceCount: 0,
          status,
          currentVersion: 1
        },
        msg: 'success'
      }
    },
    postBusiness: async (pathname) => {
      calls.push(['postBusiness', pathname])
      assert.equal(pathname, '/system/custom-field/create-version?id=456')
      status = 'DRAFT'
      return { code: 0, data: true, msg: 'success' }
    },
    deleteBusiness: async () => {
      calls.push(['deleteBusiness'])
      throw new Error('delete denied')
    }
  }
  const caseRecord = { notes: [], checks: [] }

  await cleanupCustomField({ api, fieldId: 456, fixture, caseRecord })

  assert.equal(calls[2][1], '/system/custom-field/create-version?id=456')
  assert.match(caseRecord.notes[0], /PB040-002 清理失败 fieldId=456: delete denied/)
  assert.equal(fixture.cleanup, 'NOT_CLEANED')
  assert.equal(caseRecord.checks.at(-1).passed, false)
})

test('custom-field write scope requires explicit local tenant-1 opt-in and safe endpoints', () => {
  const settings = {
    target: 'local',
    tenantId: '1',
    tenantName: 'CFOR 标准平台',
    apiBase: 'http://127.0.0.1:48083',
    webBase: 'http://127.0.0.1:9151',
    db: { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard' }
  }
  const auth = { token: 'token', tenantId: '1' }
  assert.doesNotThrow(() =>
    assertCustomFieldWriteScope(settings, auth, { CFOR_E2E_WRITE_FIXTURES: 'true' }))
  for (const change of [
    { env: { CFOR_E2E_WRITE_FIXTURES: 'false' } },
    { auth: { token: 'token', tenantId: '2' } },
    { settings: { ...settings, apiBase: 'http://127.0.0.1:48084' } },
    { settings: { ...settings, db: { ...settings.db, name: 'cfor_admin_saas' } } }
  ]) {
    assert.throws(() =>
      assertCustomFieldWriteScope(
        change.settings || settings,
        change.auth || auth,
        change.env || { CFOR_E2E_WRITE_FIXTURES: 'true' }
      ), /BLOCKED:/)
  }
})

test('custom-field catalog mappings require matching passed evidence and preserve gaps', () => {
  const caseRecord = { id: 'PB040-001', checks: [], notes: [] }
  initializeCatalogChecks(caseRecord, 'PB040-001')
  caseRecord.checks.push({ name: 'page', passed: true, details: 'two tabs' })
  catalogCheck(caseRecord, 0, ['page'])
  assert.equal(caseRecord.catalogChecks[0].status, 'VERIFIED')
  assert.equal(caseRecord.catalogChecks[1].status, 'GAP')
  const conclusion = catalogConclusion(caseRecord)
  assert.equal(conclusion.partial, true)
  assert.match(conclusion.note, /GAP:/)
})

test('custom-field object and runtime helpers reject empty or unpublished evidence', () => {
  assert.equal(evaluateObjectPlacements([]), false)
  assert.equal(evaluateObjectPlacements([{
    objectCode: 'crm.customer',
    moduleCode: 'crm',
    headerSupported: true,
    bodySupported: false,
    supportedPlacements: ['FORM_HEADER', 'DETAIL', 'API']
  }]), true)
  const definition = {
    id: 7,
    fieldCode: 'E2E_PB040_TEST',
    dataType: 'TEXT',
    status: 'PUBLISHED',
    currentVersion: 1
  }
  const schema = [{
    ...definition,
    status: 'PUBLISHED',
    bindings: [{ businessObject: 'crm.customer', placement: 'FORM_HEADER' }]
  }]
  assert.equal(evaluateRuntimeSnapshot(schema, definition, true), true)
  assert.equal(evaluateRuntimeSnapshot([], { ...definition, status: 'DRAFT' }, false), false)
})
