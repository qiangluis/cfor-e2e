import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ERROR_CODES,
  QUALITY_PENDING_CATALOG_ASSERTIONS,
  QUALITY_PENDING_CASE_ID,
  assertQualityPendingScope,
  createOwnershipLedger,
  exerciseQualityPendingSource,
  recordQualityPendingCatalogEvidence,
  recordOwnershipFailure,
  runAdditionalPendingSources,
  pendingPageCellsMatch,
  pendingSnapshotMatches,
  resolveWmsScene,
  stringId,
  verifyOwnedPendingCleanup
} from '../fixtures/quality-pending-closure.mjs'
import {
  assertPendingPermissions,
  assertPublishedIqcPlan,
  classifyPendingProbe,
  pendingSourceId
} from '../fixtures/quality-pending-source.mjs'

const local = {
  target: 'local',
  tenantId: '1',
  tenantName: 'CFOR 标准平台',
  apiBase: 'http://127.0.0.1:48083',
  webBase: 'http://127.0.0.1:9151',
  db: { host: '127.0.0.1', port: '3306', name: 'cfor_admin_standard' }
}

test('IQC opt-in does not authorize production/sales source inventory writes', async () => {
  const previous = process.env.CFOR_QUALITY_PENDING_PREPARE_ADDITIONAL
  delete process.env.CFOR_QUALITY_PENDING_PREPARE_ADDITIONAL
  let prepared = false
  try {
    await assert.rejects(runAdditionalPendingSources({
      helpers: {
        prepareQualityPendingProductionSources: async () => { prepared = true },
        prepareQualityPendingSalesSource: async () => { prepared = true }
      }
    }), /涉及库存写侧/)
    assert.equal(prepared, false)
  } finally {
    if (previous === undefined) delete process.env.CFOR_QUALITY_PENDING_PREPARE_ADDITIONAL
    else process.env.CFOR_QUALITY_PENDING_PREPARE_ADDITIONAL = previous
  }
})

test('QUALITY-PENDING-001 keeps IDs as strings and rejects numeric precision hazards', () => {
  assert.equal(QUALITY_PENDING_CASE_ID, 'QUALITY-PENDING-001')
  assert.equal(stringId('9223372036854775807', 'source'), '9223372036854775807')
  assert.throws(() => stringId(9223372036854775807, 'source'), /必须以字符串传递/)
  assert.throws(() => stringId('', 'source'), /必须以字符串传递/)
})

test('QUALITY-PENDING-001 rejects remote targets, other tenants and other databases', () => {
  assert.doesNotThrow(() => assertQualityPendingScope(local))
  for (const change of [
    { target: 'production' },
    { tenantId: '2' },
    { tenantName: '福奇科技' },
    { apiBase: 'http://example.invalid:48083' },
    { webBase: 'http://127.0.0.1:9152' },
    { db: { ...local.db, name: 'cfor_admin_saas_standard' } }
  ]) {
    assert.throws(() => assertQualityPendingScope({ ...local, ...change }), /BLOCKED:/)
  }
})

test('QUALITY-PENDING-001 records ownership cleanup without deleting shared sources', () => {
  const ledger = createOwnershipLedger()
  ledger.sourceId = 'wms-source-1'
  ledger.pendingId = 'pending-1'
  recordOwnershipFailure(ledger, new Error('register failed'))
  assert.equal(ledger.sourceCreatedByCase, false)
  assert.equal(ledger.failures.length, 1)
  assert.match(ledger.cleanup[0], /不执行来源删除/)

  const owned = createOwnershipLedger()
  owned.sourceCreatedByCase = true
  recordOwnershipFailure(owned, 'create failure')
  assert.match(owned.cleanup[0], /禁止猜测删除/)
})

test('QUALITY-PENDING-001 maps a real sales outbound source to OQC and rejects mismatched scene', () => {
  assert.deepEqual(resolveWmsScene({ stockIoType: '201', srcBillType: 'SalOrder' }), {
    qcType: 'OQC',
    sourceScene: 'SALES_OUTBOUND'
  })
  assert.equal(ERROR_CODES.SOURCE_UNSUPPORTED, 2010920007)
  assert.equal(ERROR_CODES.SAMPLE_QTY_INVALID, 2010920008)
})

test('QUALITY-PENDING-001 accepts authenticated super_admin without wildcard permission', () => {
  const access = assertPendingPermissions({
    user: { id: '1', username: 'admin' },
    roles: ['super_admin'],
    permissions: ['mes:quality-pending:query']
  }, ['mes:quality-pending:register'])
  assert.deepEqual(access, { userId: '1', mode: 'existing-super-admin' })
})

test('QUALITY-PENDING-001 does not treat a permission array as a forged super_admin role', () => {
  assert.throws(() => assertPendingPermissions({
    user: { id: '1', username: 'admin' },
    roles: ['user'],
    permissions: ['mes:quality-pending:query']
  }, ['mes:quality-pending:register']), /缺少权限/)
})

test('QUALITY-PENDING-001 distinguishes forbidden, DTO and pre-write service probe results', () => {
  assert.equal(classifyPendingProbe({ status: 403, body: { code: 403 } }), 'FORBIDDEN')
  assert.equal(classifyPendingProbe({ status: 400, body: { code: 400 } }), 'DTO_REJECTION_NOT_PERMISSION_PROOF')
  assert.equal(classifyPendingProbe({
    status: 200,
    body: { code: 2010920003, msg: '不支持的检验类型：null' }
  }), 'PRE_WRITE_SERVICE_REJECTION')
})

test('QUALITY-PENDING-001 requires a published, current type-101 plan binding', () => {
  const result = assertPublishedIqcPlan({
    id: '2',
    type: 101,
    publishStatus: 1,
    versionNo: 1,
    planCode: 'PLAN-101'
  }, {
    materialId: '1',
    planId: '2',
    type: '101',
    isDefault: true,
    effectiveFrom: '2026-01-01'
  }, '1', '2', new Date('2026-10-13T00:00:00Z'))
  assert.deepEqual(result, { id: '2', code: 'PLAN-101', version: 1 })
  assert.throws(() => assertPublishedIqcPlan({
    id: '2', type: 104, publishStatus: 1, versionNo: 1, planCode: 'PLAN-104'
  }, {
    materialId: '1', planId: '2', type: '101', isDefault: true, effectiveFrom: '2026-01-01'
  }, '1', '2'), /101 方案/)
})

test('QUALITY-PENDING-001 preserves safe string IDs and rejects 106 or shared draft shapes', () => {
  assert.equal(pendingSourceId('9223372036854775807'), '9223372036854775807')
  assert.throws(() => pendingSourceId(9223372036854775807), /ID/)
})

test('QUALITY-PENDING-001 preserves catalog assertions and marks uncovered source scenes as gaps', () => {
  const caseRecord = { checks: [], notes: [], evidence: [] }
  const assertions = recordQualityPendingCatalogEvidence(caseRecord, {
    sourceChainVerified: true,
    idempotentVerified: true,
    snapshotVerified: true,
    validationVerified: true,
    pageVerified: true,
    sourceId: '101-source',
    sourceEntryId: '101-entry',
    sourceBillNo: 'ASN-OWNED',
    planId: '101-plan',
    planVersion: 1,
    duplicateDetails: 'first=pending; duplicate=pending; rows=1; pendingQty=2',
    validationDetails: 'sampleQtyCode=2010920008; sourceSceneCode=2010920007',
    pageDetails: 'route=/quality/pendingInspect; fields=来源场景/检验方案/抽检方式/样本量/指定/实际检验员/检验期限'
  })
  assert.deepEqual(assertions.map((item) => item.assertion), [...QUALITY_PENDING_CATALOG_ASSERTIONS])
  assert.deepEqual(assertions.map((item) => item.status), [
    'PARTIAL', 'VERIFIED', 'VERIFIED', 'PARTIAL', 'VERIFIED'
  ])
  assert.deepEqual(caseRecord.remainingAssertions, [
    '生产过程 PROCESS_INSPECTION 来源',
    '生产入库 PRODUCTION_INBOUND 来源',
    '销售出库 SALES_OUTBOUND 来源',
    '销售退货 SALES_RETURN 来源',
    '质量计划 QUALITY_PLAN 来源',
    QUALITY_PENDING_CATALOG_ASSERTIONS[3]
  ])
  assert.ok(assertions.every((item) => item.evidence && !item.evidence.includes('rows=[]')))
  assert.equal(caseRecord.catalogComplete, false)
})

test('QUALITY-PENDING-001 verifies cancellation by rereading owned pending, ASN, order and type101 draft', async () => {
  const ledger = {
    pendingId: '901',
    sourceId: '902',
    sourceEntryId: '903',
    marker: 'E2E-QP-OWNED'
  }
  const context = {
    noticeId: '904',
    noticeLineId: '905',
    orderId: '906'
  }
  const caseRecord = { checks: [], notes: [], evidence: [], database: [] }
  const api = {
    async getBusiness(path) {
      if (path.includes('/pending-inspect/get')) {
        return { code: 0, data: {
          id: '901', status: 'CANCELLED', cancelReason: 'QUALITY-PENDING-001 reverse',
          sourceBillId: '902', sourceEntryId: '903'
        } }
      }
      if (path.includes('/pending-inspect/list-by-source')) {
        return { code: 0, data: [{
          id: '901', status: 'CANCELLED', sourceBillId: '902', sourceEntryId: '903'
        }] }
      }
      if (path.includes('/stkIo/queryById')) {
        return { code: 0, data: {
          id: '902', stockIoType: '101', srcBillType: 'MesWmsArrivalNotice',
          billStage: '12', isEffective: 0, isVoided: 0
        } }
      }
      if (path.includes('/arrival-notice/get')) {
        return { code: 0, data: {
          id: '904', purchaseOrderId: '906', status: 10,
          lines: [{ id: '905', receivedQuantity: 0 }]
        } }
      }
      if (path.includes('/purchase-order/get')) {
        return { code: 0, data: {
          id: '906', isEffective: 1, isVoided: 0, remark: 'E2E-QP-OWNED'
        } }
      }
      throw new Error(`unexpected ${path}`)
    }
  }
  const result = await verifyOwnedPendingCleanup({
    api,
    ledger,
    context,
    caseRecord,
    readSql: async () => ({ available: true, rows: [
      ['pending', '901', 'CANCELLED', '902', '903', 'QUALITY-PENDING-001 reverse'],
      ['source', '902', '101', '12', '0', '0'],
      ['notice', '904', '10', '906']
    ] })
  })
  assert.equal(result.pending.id, '901')
  assert.equal(caseRecord.checks.at(-1).passed, true)
  assert.match(caseRecord.evidence.at(-1), /来源保留作审计/)
  assert.equal(caseRecord.database.at(-1).stage, 'quality-pending-owned-cleanup-readback')
})

const snapshotPayload = {
  qcType: 'OQC', sourceScene: 'SALES_OUTBOUND', sourceBillType: 'MesStkIo',
  sourceBillId: '9223372036854775807', sourceEntryId: '9123372036854775807',
  sourceBillNo: 'SO-OWNED', materialId: '101', inspectionPlanId: '102',
  inspectionPlanCode: 'PLAN-OWNED', inspectionPlanVersion: 3,
  assignedInspectorUserId: '1', samplingType: 'FIXED', sampleQty: 1, pendingQty: 1,
  dueTime: '2026-10-14T15:00:00'
}
const pageCells = [
  '出货检验', 'SO-OWNED', '销售出库检验', 'OWNED-MATERIAL',
  'PLAN-OWNED / V3', '固定抽样 / 1', '1 / -', '2026-10-14T15:00:00'
]

test('pending snapshots require real source key, plan version, quantity and assigned user', () => {
  const row = { ...snapshotPayload, id: '900', status: 'WAITING' }
  assert.equal(pendingSnapshotMatches(row, snapshotPayload, { pendingId: '900' }), true)
  for (const change of [
    { status: 'CANCELLED' }, { sourceBillId: '999' }, { sourceEntryId: '999' },
    { sourceScene: 'QUALITY_PLAN' }, { qcType: 'IQC' }, { inspectionPlanVersion: 2 },
    { assignedInspectorUserId: '2' }, { pendingQty: 2 }, { dueTime: null }
  ]) {
    assert.equal(pendingSnapshotMatches({ ...row, ...change }, snapshotPayload, { pendingId: '900' }), false)
  }
})

test('pending page cannot pass from headers, a bill number or unrelated field values', () => {
  assert.equal(pendingPageCellsMatch(pageCells, snapshotPayload), true)
  assert.equal(pendingPageCellsMatch(['SO-OWNED'], snapshotPayload), false)
  for (const index of [1, 2, 4, 5, 6, 7]) {
    const cells = [...pageCells]
    cells[index] = '-'
    assert.equal(pendingPageCellsMatch(cells, snapshotPayload), false)
  }
})

test('pending catalog does not claim a source chain when no real source was verified', () => {
  const caseRecord = {}
  recordQualityPendingCatalogEvidence(caseRecord, { sourceChainVerified: false })
  assert.ok(caseRecord.catalogAssertions.every(row => row.status === 'PARTIAL'))
  assert.equal(caseRecord.remainingAssertions.length, 10)
  assert.deepEqual(JSON.parse(caseRecord.catalogAssertions[0].evidence).verified, [])
})

test('pending catalog expands only real verified scenes and keeps missing RQC validation partial', () => {
  const caseRecord = {}
  const sceneEvidence = ['PURCHASE_INBOUND', 'PROCESS_INSPECTION', 'PRODUCTION_INBOUND', 'SALES_OUTBOUND']
    .map((sourceScene, index) => ({
      sourceScene, qcType: ['IQC', 'IPQC', 'IPQC', 'OQC'][index],
      chainVerified: true, idempotentVerified: true, snapshotVerified: true,
      validationVerified: true, pageVerified: true, sourceBillId: String(index + 1),
      sourceEntryId: String(index + 11), pendingId: String(index + 21),
      duplicateDetails: 'same-ID qty 1->2', validationDetails: 'exact-codes; unchanged',
      pageDetails: 'exact row cells'
    }))
  recordQualityPendingCatalogEvidence(caseRecord, { sceneEvidence })
  assert.equal(JSON.parse(caseRecord.catalogAssertions[0].evidence).verified.length, 4)
  assert.deepEqual(JSON.parse(caseRecord.catalogAssertions[3].evidence).missingQcTypes, ['RQC'])
  assert.deepEqual(caseRecord.catalogAssertions.map(row => row.status),
    ['PARTIAL', 'VERIFIED', 'VERIFIED', 'PARTIAL', 'VERIFIED'])
  assert.equal(caseRecord.catalogComplete, false)
  assert.equal(caseRecord.remainingAssertions.length, 3)
})

test('pending WMS scenes reject contradictory or merely substring-matched sources', () => {
  for (const detail of [
    { stockIoType: '301', srcBillType: 'PurReturn' },
    { stockIoType: '106', srcBillType: 'PurOrder' },
    { stockIoType: '101', srcBillType: 'SalOrder' },
    { stockIoType: '104', srcBillType: 'SHARED' },
    { stockIoType: '302', srcBillType: 'FakeReturn' }
  ]) assert.throws(() => resolveWmsScene(detail), /BLOCKED/)
})

function pendingLifecycleHarness ({ mutateNegative = false, badPage = false } = {}) {
  let pending
  let payload
  let cancels = 0
  const api = {
    async getBusiness(path) {
      if (path.includes('/get?')) return { code: 0, data: structuredClone(pending) }
      if (path.includes('/list-by-source?')) return { code: 0, data: pending ? [structuredClone(pending)] : [] }
      throw Error(`unexpected ${path}`)
    },
    async postBusiness(path, body) {
      return this.post(path, body)
    },
    async post(path, body) {
      if (path.includes('/cancel?')) {
        cancels++
        pending.status = 'CANCELLED'
        pending.cancelReason = decodeURIComponent(path.split('&reason=')[1])
        return { code: 0, data: true }
      }
      if (body.sampleQty > body.pendingQty) {
        if (mutateNegative) pending.pendingQty++
        return { code: ERROR_CODES.SAMPLE_QTY_INVALID, msg: '样本量超出待检数量' }
      }
      if (body.sourceScene !== 'SALES_OUTBOUND') {
        return { code: ERROR_CODES.SOURCE_UNSUPPORTED, msg: '来源场景不支持' }
      }
      payload = body
      pending = pending
        ? { ...pending, pendingQty: pending.pendingQty + body.pendingQty }
        : { ...body, id: '900', status: 'WAITING' }
      return { code: 0, data: '900' }
    }
  }
  const row = {
    filter: () => row, first: () => row, waitFor: async () => {},
    count: async () => 1,
    locator: () => ({
      allTextContents: async () => badPage ? ['SO-OWNED'] : [
        '出货检验', payload.sourceBillNo, '销售出库检验', 'MATERIAL-OWNED',
        `${payload.inspectionPlanCode} / V${payload.inspectionPlanVersion}`,
        '固定抽样 / 1', '1 / -', payload.dueTime
      ]
    })
  }
  const page = {
    url: () => 'http://127.0.0.1:9151/quality/pendingInspect',
    getByPlaceholder: () => ({ fill: async () => {}, press: async () => {} }),
    locator: () => row
  }
  return {
    api, page,
    helpers: { openRoute: async () => {}, saveScreenshot: async () => {} },
    readSql: async () => ({ available: true, rows: [[
      '900', 'CANCELLED', 'OQC', 'SALES_OUTBOUND', 'MesStkIo', '20', '21', '22',
      '1', '1', 'FIXED', '1.000000', '2.000000', 'QUALITY-PENDING-001 reverse'
    ]] }),
    state: () => ({ pending, cancels })
  }
}

const ownedPendingSource = {
  sourceScene: 'SALES_OUTBOUND', qcType: 'OQC', sourceBillType: 'MesStkIo',
  sourceBillId: '20', sourceEntryId: '21', sourceBillNo: 'SO-OWNED', marker: 'E2E-QP-OWNED',
  plan: { id: '22', code: 'PLAN-OWNED', version: 1 },
  source: { materialId: '23', pendingQty: 1, entry: { unitId: '24', entryNo: 1 },
    detail: { billNo: 'SO-OWNED' } }
}

test('expanded pending lifecycle verifies duplicate, negative readback, actual page values and cancel audit', async () => {
  const h = pendingLifecycleHarness()
  const caseRecord = { checks: [], evidence: [], sourceSceneEvidence: [] }
  const evidence = await exerciseQualityPendingSource({
    ...h, caseRecord, prepared: ownedPendingSource, inspectorId: '1'
  })
  assert.equal(evidence.chainVerified, true)
  assert.equal(evidence.validationVerified, true)
  assert.equal(evidence.pageVerified, true)
  assert.equal(evidence.cleanupVerified, true)
  assert.equal(h.state().pending.status, 'CANCELLED')
  assert.equal(h.state().pending.pendingQty, 2)
  assert.equal(h.state().cancels, 1)
})

for (const failure of ['mutateNegative', 'badPage']) {
  test(`expanded pending lifecycle rejects ${failure} and still formally cancels its owned row`, async () => {
    const h = pendingLifecycleHarness({ [failure]: true })
    const caseRecord = { checks: [], evidence: [], sourceSceneEvidence: [] }
    await assert.rejects(exerciseQualityPendingSource({
      ...h, caseRecord, prepared: ownedPendingSource, inspectorId: '1'
    }), failure === 'mutateNegative' ? /负例改变/ : /字段值不匹配/)
    assert.equal(h.state().pending.status, 'CANCELLED')
    assert.equal(h.state().cancels, 1)
    assert.ok(caseRecord.checks.some(row => row.passed === false))
    assert.equal(caseRecord.sourceSceneEvidence[0].cleanupVerified, false)
  })
}
