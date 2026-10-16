import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import {
  rdmSyntheticReleaseContents, prepareRdmReleaseArtifacts, verifyRdmReleaseArtifacts,
  RDM_ASSERTION_BINDINGS, initializeRdmAssertions, finalizeRdmAssertions
} from '../fixtures/rdm.mjs'

const previousWriteFlag = process.env.CFOR_E2E_WRITE_FIXTURES
process.env.CFOR_E2E_WRITE_FIXTURES = 'true'
after(() => {
  if (previousWriteFlag === undefined) delete process.env.CFOR_E2E_WRITE_FIXTURES
  else process.env.CFOR_E2E_WRITE_FIXTURES = previousWriteFlag
})

const target = {
  target: 'local', tenantId: '1', apiBase: 'http://127.0.0.1:48083',
  webBase: 'http://127.0.0.1:9151', requestTimeoutMs: 1000
}
const tag = 'E2E-RDM-RDM006-offline-only'
const hash = (value) => createHash('sha256').update(value).digest('hex')
const frozenHash = hash('metadata fingerprint, not a file-content digest')

function harness (options = {}) {
  const caseRecord = { checks: [], notes: [], evidence: [] }
  const state = { files: [], writes: [], downloads: [], reads: [], safety: 0, metadata: {} }
  const fixture = { tag, ownerId: '100' }
  const sqlReader = async (sql) => {
    state.reads.push(sql)
    let rows
    if (sql.includes('FROM infra_file_config')) rows = options.storageRows || [['9', '10']]
    else if (sql.includes('FROM infra_file WHERE')) {
      const file = state.files.at(-1)
      rows = [[file.id, '9', file.name, file.path, file.url, String(file.bytes.length)]]
      if (options.wrongFileIdentity) rows[0][3] = 'another-fixture/file.json'
    } else {
      const { package: pkg, backup, rollback } = state.metadata
      rows = [
        ['package', '201', '200', pkg.packageName, pkg.packageUri, pkg.checksum, pkg.packageType],
        ['backup', '202', '200', backup.backupType, backup.backupUri, '1', '100'],
        ['rollback', '203', '200', hash(rollback.rollbackPlan), hash(rollback.detail), '0'],
        ['release', '200', frozenHash, '1', 'PENDING_RELEASE']
      ]
      options.mutateSql?.(rows)
    }
    return { available: true, rows }
  }
  const api = {
    async uploadBusiness (path, form) {
      assert.equal(path, '/infra/file/upload')
      assert.ok(form instanceof FormData)
      assert.deepEqual([...form.keys()].sort(), ['directory', 'file'])
      assert.equal(form.get('directory'), tag)
      const upload = form.get('file')
      assert.equal(upload.type, 'application/json')
      const file = {
        id: String(501 + state.files.length), name: upload.name,
        path: `${tag}/20261015/${upload.name}`,
        bytes: Buffer.from(await upload.arrayBuffer())
      }
      file.url = `${target.apiBase}/admin-api/infra/file/9/get/${file.path}`
      state.files.push(file)
      return options.uploadPayload || { code: 0, data: options.uploadUrl || file.url }
    },
    async postBusiness (path, body) {
      state.writes.push({ path, body })
      const kind = path.split('/')[3]
      state.metadata[kind] = { ...body }
      return { code: 0, data: { package: '201', backup: '202', rollback: '203' }[kind] }
    },
    async getBusiness (path) {
      const kind = path.split('/')[3]
      const row = { id: { package: '201', backup: '202', rollback: '203' }[kind], ...state.metadata[kind] }
      options.mutateApi?.(kind, row)
      return { code: 0, data: [row] }
    }
  }
  const fetchFile = async (url, init) => {
    state.downloads.push({ url, init })
    assert.equal(init.redirect, 'error')
    assert.equal(init.credentials, 'omit')
    assert.equal(init.headers, undefined)
    const file = state.files.find((file) => file.url === url)
    assert.ok(file)
    if (options.redirected) return { ok: true, redirected: true }
    return new Response(options.corruptBytes ? Buffer.concat([file.bytes, Buffer.from('tampered')]) : file.bytes,
      { status: options.httpStatus || 200 })
  }
  const args = {
    api, fixture, releaseId: '200', caseRecord, target, sqlReader, fetchFile,
    writeSafety: async () => { state.safety++; if (options.safetyFailure) throw new Error('unsafe database') }
  }
  return { args, state, caseRecord, prepare: () => prepareRdmReleaseArtifacts(args) }
}

test('synthetic package and FILE backup use exact byte digests and a restorable isolated payload', () => {
  const contents = rdmSyntheticReleaseContents(tag)
  const pkg = JSON.parse(contents.package.bytes)
  const backup = JSON.parse(contents.backup.bytes)
  assert.equal(pkg.synthetic, true)
  assert.equal(pkg.fixture, tag)
  assert.equal(contents.package.sha256, hash(contents.package.bytes))
  assert.equal(contents.backup.sha256, hash(contents.backup.bytes))
  assert.notEqual(contents.package.sha256, contents.backup.sha256)
  assert.deepEqual(Buffer.from(backup.content, 'base64'), contents.package.bytes)
  assert.match(contents.package.name, /\.json$/)
  assert.match(contents.rollbackPlan, /No deployment or database restore is authorized/)
  assert.throws(() => rdmSyntheticReleaseContents('../../shared'), /专属目录/)
})

test('formal multipart uploads and DTOs contain actual checksums without invented backup hash fields', async () => {
  const h = harness()
  const artifacts = await h.prepare()
  assert.equal(h.state.safety, 1)
  assert.equal(h.state.files.length, 2)
  assert.equal(h.state.downloads.length, 2)
  assert.equal(h.state.writes.length, 3)
  assert.deepEqual(h.state.metadata.package, {
    releaseId: '200', packageName: artifacts.package.name, packageUri: artifacts.package.url,
    checksum: hash(artifacts.package.bytes), packageType: 'TEST'
  })
  assert.deepEqual(h.state.metadata.backup, {
    releaseId: '200', backupType: 'FILE', backupUri: artifacts.backup.url, verified: true, verifiedBy: '100'
  })
  assert.deepEqual(h.state.metadata.rollback, {
    releaseId: '200', rollbackPlan: artifacts.rollbackPlan, detail: artifacts.detail, executed: false
  })
  assert.equal(h.caseRecord.releaseArtifactContents.serverContentBindingVerified, false)
  assert.equal(h.caseRecord.releaseArtifactContents.rollbackExecuted, false)
})

test('frozen API, SQL inline-text hashes and file downloads reconcile independently', async () => {
  const h = harness()
  const artifacts = await h.prepare()
  await verifyRdmReleaseArtifacts({ ...h.args, artifacts, frozenHash })
  assert.equal(h.state.downloads.length, 4)
  assert.ok(h.caseRecord.checks.every((check) => check.passed === true))
  const sql = h.state.reads.at(-1)
  assert.match(sql, /SHA2\(rollback_plan,256\)/)
  assert.match(sql, /tenant_id=1 AND deleted=0 AND release_id=200 AND id=201/)
  assert.doesNotMatch(h.state.reads.join('\n'), /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\s/i)
})

for (const storageRows of [[], [['1', '20']], [['1', '11']], [['1', '12']], [['1', '1'], ['2', '10']]]) {
  test(`unsafe or ambiguous master storage blocks all uploads: ${JSON.stringify(storageRows)}`, async () => {
    const h = harness({ storageRows })
    await assert.rejects(h.prepare, /仅允许 DB\/LOCAL 主存储/)
    assert.equal(h.state.files.length, 0)
    assert.equal(h.state.writes.length, 0)
  })
}

test('local write safety blocks all uploads before any file configuration lookup', async () => {
  const h = harness({ safetyFailure: true })
  await assert.rejects(h.prepare, /unsafe database/)
  assert.equal(h.state.files.length, 0)
  assert.equal(h.state.reads.length, 0)
})

test('an absent write opt-in blocks uploads even with safe mocked storage', async () => {
  const h = harness()
  process.env.CFOR_E2E_WRITE_FIXTURES = 'false'
  try {
    await assert.rejects(h.prepare, /CFOR_E2E_WRITE_FIXTURES=true/)
  } finally {
    process.env.CFOR_E2E_WRITE_FIXTURES = 'true'
  }
  assert.equal(h.state.files.length, 0)
})

for (const uploadUrl of [
  'e2e://synthetic/package', 'https://example.com/file',
  'http://127.0.0.1:48084/admin-api/infra/file/9/get/file',
  `http://127.0.0.1:48083/admin-api/infra/file/10/get/${tag}/file`,
  'http://127.0.0.1:48083/admin-api/infra/file/9/get/shared/file',
  `http://127.0.0.1:48083/admin-api/infra/file/9/get/${tag}/file?redirect=external`
]) {
  test(`nonlocal, wrong storage or unowned URL is never downloaded: ${uploadUrl}`, async () => {
    const h = harness({ uploadUrl })
    await assert.rejects(h.prepare, /本地正式文件接口/)
    assert.equal(h.state.downloads.length, 0)
    assert.equal(h.state.writes.length, 0)
  })
}

for (const options of [
  { corruptBytes: true }, { redirected: true }, { httpStatus: 404 }, { wrongFileIdentity: true },
  { uploadPayload: { code: 403, data: 'url', msg: 'forbidden' } },
  { uploadPayload: { status: 200, data: 'url' } }
]) {
  test(`HTTP success or metadata alone cannot replace verified upload bytes: ${JSON.stringify(options)}`, async () => {
    const h = harness(options)
    await assert.rejects(h.prepare)
    assert.equal(h.state.writes.length, 0)
    assert.equal(h.caseRecord.checks.length, 0)
  })
}

for (const [label, options] of [
  ['package checksum', { mutateApi: (kind, row) => { if (kind === 'package') row.checksum = frozenHash } }],
  ['wrong release', { mutateApi: (kind, row) => { row.releaseId = '999' } }],
  ['false rollback execution', { mutateApi: (kind, row) => { if (kind === 'rollback') row.executed = true } }],
  ['SQL content digest', { mutateSql: (rows) => { rows[2][3] = frozenHash } }],
  ['SQL frozen hash', { mutateSql: (rows) => { rows[3][2] = hash('other freeze') } }],
  ['SQL missing row', { mutateSql: (rows) => { rows.pop() } }]
]) {
  test(`frozen reconciliation rejects ${label}`, async () => {
    const h = harness(options)
    const artifacts = await h.prepare()
    await assert.rejects(() => verifyRdmReleaseArtifacts({ ...h.args, artifacts, frozenHash }), /API|对账失败/)
    assert.ok(!h.caseRecord.checks.some((check) => /冻结后发布资料/.test(check.name)))
  })
}

test('post-freeze changed file bytes fail even when API, SQL and metadata hash agree', async () => {
  const options = {}
  const h = harness(options)
  const artifacts = await h.prepare()
  options.corruptBytes = true
  await assert.rejects(() => verifyRdmReleaseArtifacts({ ...h.args, artifacts, frozenHash }), /SHA-256 不一致/)
  assert.ok(!h.caseRecord.checks.some((check) => /冻结后发布资料/.test(check.name)))
})

test('even every passing evidence check cannot close the server content-binding GAP', () => {
  const record = { checks: [], notes: [], evidence: [] }
  initializeRdmAssertions(record, 'RDM-006')
  for (const name of new Set(RDM_ASSERTION_BINDINGS['RDM-006'].flatMap(([, names]) => names))) {
    record.checks.push({ name, passed: true })
  }
  const result = finalizeRdmAssertions(record, 'RDM-006')
  assert.equal(result.partial, true)
  assert.equal(result.acceptanceComplete, false)
  assert.equal(record.catalogAssertions[2].status, 'GAP')
  assert.match(record.catalogAssertions[2].details, /调用方提交.*只覆盖元数据/)
  assert.match(record.catalogAssertions[2].details, /PENDING_RELEASE/)
})

test('RDM006 uses the closure helpers and never fabricates deployment or rollback completion', () => {
  const source = fs.readFileSync(new URL('../fixtures/rdm.mjs', import.meta.url), 'utf8')
  const branch = source.slice(source.indexOf("  if (caseId === 'RDM-006')"))
  assert.match(branch, /await prepareRdmReleaseArtifacts/)
  assert.match(branch, /await verifyRdmReleaseArtifacts/)
  assert.doesNotMatch(branch, /e2e:\/\/|executed:\s*true|status:\s*'(?:SUCCESS|RELEASING)'/)
})
