import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  assertProductionAndon, productionAndonId,
  finalizeProductionCatalogEvidence, isMissingProductionWork, productionPageRows,
  productionCloseChecks, productionReleaseGateChecks, productionStatusChecks
} from '../suites/mes-production.mjs'
import { caseOutcome } from '../lib/report.mjs'

const source = fs.readFileSync(new URL('../suites/mes-production.mjs', import.meta.url), 'utf8')
const executionFixtureSource = fs.readFileSync(
  new URL('../fixtures/mes-execution-write.mjs', import.meta.url), 'utf8'
)
const production001 = source.slice(
  source.indexOf("if (caseId === 'MES-PROD-001')"),
  source.indexOf("if (caseId === 'MES-PROD-002')")
)
const production002 = source.slice(
  source.indexOf("if (caseId === 'MES-PROD-002')"),
  source.indexOf("if (caseId === 'MES-PROD-003')")
)
const production003 = source.slice(
  source.indexOf("if (caseId === 'MES-PROD-003')"),
  source.indexOf("if (caseId === 'MES-PROD-004')")
)
const production004 = source.slice(
  source.indexOf("if (caseId === 'MES-PROD-004')"),
  source.indexOf("if (caseId === 'MES-PROD-005')")
)
const production006 = source.slice(
  source.indexOf("if (caseId === 'MES-PROD-006')"),
  source.indexOf("if (caseId === 'MES-PROD-007')")
)
const production007 = source.slice(
  source.indexOf("if (caseId === 'MES-PROD-007')"),
  source.indexOf("\n  }\n\n  caseRecord.notes.push(",
    source.indexOf("if (caseId === 'MES-PROD-007')"))
)

test('production pages accept CommonResult and legacy Result without losing string IDs', () => {
  const rows = [{ id: '2106200343998562305' }]
  assert.deepEqual(productionPageRows({ code: 0, data: { list: rows, total: 1 } }, 'work'), rows)
  assert.deepEqual(productionPageRows({
    code: 200, success: true, data: { records: rows, total: 1 }
  }, 'work'), rows)
  assert.deepEqual(productionPageRows({ code: 0, data: rows }, 'work'), rows)
  assert.deepEqual(productionPageRows({
    code: 200, success: true, data: { records: [], total: 0 }
  }, 'work'), [])
})

test('MES-PROD-004 reads inbound delivery time before and after the finish transition', () => {
  assert.match(production004, /104入库足额后实际交期写入/)
  assert.match(production004, /工单完工状态切换保留入库实际交期/)
  assert(production004.indexOf('const stockedWork =') <
    production004.indexOf('const finishedWork = await fixture.finishWork()'))
  assert.match(production004,
    /finishedWork\?\.actualDeliveryTime === stockedWork\.actualDeliveryTime/)
})

test('MES-PROD-004 collects owned WMS evidence before finish and cleanup without satisfying putaway', () => {
  assert.match(source, /import \{ collectMesProductionWmsEvidence \}/)
  assert.match(production004, /await collectMesProductionWmsEvidence\(\{\s*fixture, page, context: page\.context\(\), caseRecord, outputDir, record, quantity: 2\s*\}\)/)
  assert(production004.indexOf('const stockedWork =') <
    production004.indexOf('await collectMesProductionWmsEvidence('))
  assert(production004.indexOf('await collectMesProductionWmsEvidence(') <
    production004.indexOf('await fixture.finishWork()'))
  assert(production004.indexOf('await collectMesProductionWmsEvidence(') <
    production004.indexOf('await fixture.cleanup(caseRecord)'))
  const record = { checks: [
    '过程检不合格时必检门禁阻断报工审核与完工流转',
    '不合格过程检审核报工被正式拒绝',
    '不合格过程检工单完工被正式拒绝且状态未变',
    '过程检放行后生成104成品入库并回读来源',
    '工单 stockedNum 和实际交期回写',
    '工单完工状态切换保留入库实际交期'
  ].map((name) => ({ name, passed: true, details: 'owned evidence' })) }
  assert.equal(finalizeProductionCatalogEvidence(record, 'MES-PROD-004'), false)
  assert.equal(record.catalogAssertions[2].status, 'GAP')
  assert.match(record.catalogAssertions[2].details, /pendingPutawayQty=0/)
})

test('production status evidence rejects empty samples, wrong Chinese labels and non-boolean pause flags', () => {
  assert.deepEqual(productionStatusChecks([]), { codes: false, names: false, paused: false })
  const rows = [{ bizStatus: 'IN_PRODUCTION', bizStatusName: '执行中', paused: false }]
  assert.deepEqual(productionStatusChecks(rows), { codes: true, names: true, paused: true })
  assert.equal(productionStatusChecks([{ ...rows[0], bizStatusName: '草稿' }]).names, false)
  assert.equal(productionStatusChecks([{ ...rows[0], bizStatus: 'UNKNOWN' }]).codes, false)
  assert.equal(productionStatusChecks([{ ...rows[0], paused: 0 }]).paused, false)
})

test('release gate evidence requires two different gates with real conclusions and explanations', () => {
  const gate = {
    prodOrderId: '22', enabled: true, passed: false,
    items: [
      { code: 'BOM', passed: true, message: 'BOM完整' },
      { code: 'MATERIAL', passed: false, message: '缺少物料' }
    ]
  }
  assert.deepEqual(productionReleaseGateChecks(gate, '22'), { structure: true, details: true })
  assert.equal(productionReleaseGateChecks(gate, '23').structure, false)
  assert.equal(productionReleaseGateChecks({ ...gate, items: [gate.items[0], gate.items[0]] }, '22').structure, false)
  assert.equal(productionReleaseGateChecks({
    ...gate, items: [gate.items[0], { ...gate.items[1], message: '' }]
  }, '22').details, false)
})

test('close checks require exact override membership and the explicit FMS manual cost release evidence', () => {
  const gate = {
    prodOrderId: '22', passed: false, closable: false,
    overrideRequiredItems: ['PROCESS', 'COST'],
    items: [
      { item: 'PROCESS', itemName: 'process', passed: false, message: 'unfinished' },
      { item: 'MATERIAL', itemName: 'material', passed: true, message: 'settled' },
      { item: 'QUALITY', itemName: 'quality', passed: true, message: 'released' },
      { item: 'COST', itemName: 'cost', passed: false, message: 'FMS 尚未提供按生产订单查询接口，需人工确认放行' }
    ]
  }
  assert.deepEqual(productionCloseChecks(gate, '22'), {
    structure: true, conclusion: true, cost: true
  })
  for (const invalid of [
    { ...gate, overrideRequiredItems: ['COST', 'COST'] },
    { ...gate, overrideRequiredItems: ['QUALITY', 'COST'] },
    { ...gate, passed: true, closable: true },
    { ...gate, closable: true }
  ]) assert.equal(productionCloseChecks(invalid, '22').conclusion, false)
  assert.equal(productionCloseChecks(gate, '23').structure, false)
  assert.equal(productionCloseChecks({
    ...gate, items: [...gate.items.slice(0, 3), { ...gate.items[3], message: 'unavailable' }]
  }, '22').cost, false)
})

test('production acceptance binds unique passed evidence and preserves missing or duplicate checks', () => {
  const names = [
    '生产订单列表每行返回九状态编码',
    '生产订单中文状态名称与九状态枚举逐项一致',
    '暂停标记是执行中的附加布尔标记，而不是独立状态列'
  ]
  const record = { checks: names.map((name) => ({ name, passed: true, details: 'real evidence' })) }
  assert.equal(finalizeProductionCatalogEvidence(record, 'MES-PROD-005'), true)
  assert.equal(record.catalogAssertions.length, 3)
  assert.equal(record.remainingAssertions.length, 0)
  record.checks.push(record.checks[0])
  assert.equal(finalizeProductionCatalogEvidence(record, 'MES-PROD-005'), false)
  assert.equal(record.remainingAssertions.length, 1)
  record.checks = record.checks.filter((check) => check.name !== names[1])
  assert.equal(finalizeProductionCatalogEvidence(record, 'MES-PROD-005'), false)
  assert.equal(record.remainingAssertions.length, 2)
})

test('MES-PROD-003 uses the owned execution fixture and formal production/andon write paths', () => {
  assert.match(production003, /new ExecutionWorkflowFixture\(api, record, caseId, \{/)
  assert.match(production003, /withOpeningInventory: true/)
  assert.match(production003, /await fixture\.setup\(caseRecord\)/)
  assert.match(production003, /await fixture\.startWork\(\)/)
  assert.match(production003, /await fixture\.reportTask\(/)
  assert.match(executionFixtureSource, /\/mes\/prodWorkReport\/addByTaskId/)
  assert.match(executionFixtureSource, /\/mes\/prodWorkReport\/queryById\?id=/)
  assert.match(production003, /\/mes\/andon-record\/create/)
  assert.match(production003, /\/mes\/andon-record\/respond/)
  assert.match(production003, /\/mes\/andon-record\/handle/)
  assert.match(production003, /\/mes\/andon-record\/get\?id=/)
  assert.match(production003, /const created = await api\.postBusiness\(.*andon-record\/create/s)
  assert.match(production003, /productionAndonId\(created\)/)
  assert.match(source, /正式安灯创建返回无效主键/)
  assert.match(production003, /2010911003/)
  assert.match(executionFixtureSource, /captureProductionOutput/)
  assert.match(executionFixtureSource, /src_bill_type='ProdWork'/)
  assert.match(executionFixtureSource, /stock_io_type='104'/)
  assert.match(executionFixtureSource, /entry\.src_entry_id=/)
  assert.match(executionFixtureSource, /\/mes\/stkIo\/void/)
  assert.match(production003, /finalizeProductionCatalogEvidence\(caseRecord, caseId\)/)
  assert.match(production003, /fixture\.cleanup\(caseRecord\)/)
  assert.doesNotMatch(production003, /\/mes\/andon-record\/(?:close|reopen)/)
  assert.doesNotMatch(production003, /Job|INSERT INTO|UPDATE mes_/)
})

test('MES-PROD-003 records unsupported automatic andon/close/reopen semantics as catalog gaps', () => {
  assert.match(source, /自动建安灯/)
  assert.match(source, /正式 close\/reopen API 不存在/)
  assert.match(source, /普通报工工艺路线的 isQuality=0/)
  assert.match(production003, /partial: true/)
})

test('andon create IDs accept the actual CommonResult string without precision loss', () => {
  assert.equal(productionAndonId({ code: 0, data: '2109497778267541506' }), '2109497778267541506')
  assert.equal(productionAndonId({ code: 200, success: true, data: '21' }), '21')
  assert.equal(productionAndonId({ code: 0, data: 21 }), '21')
  for (const response of [
    { code: 0, data: Number.MAX_SAFE_INTEGER + 1 },
    { code: 0, data: { id: '21' } }, { code: 0, data: null },
    { code: 0, data: true }, { code: 0, data: '0' },
    { code: 2010911000, msg: '安灯呼叫记录不存在', data: '21' }
  ]) assert.throws(() => productionAndonId(response))
})

test('andon transitions reject missing, foreign or rolled-back facts before responding', () => {
  const expected = { id: '21', configId: '22', workId: '23', procedureId: '24', marker: 'AUTOTEST-MES-PROD-003-OWN' }
  const active = { ...expected, remark: expected.marker, source: 'QUALITY', status: 'ACTIVE' }
  assert.equal(assertProductionAndon(active, expected, 'ACTIVE'), active)
  for (const row of [
    null, { ...active, id: '99' }, { ...active, configId: '99' },
    { ...active, workId: '99' }, { ...active, procedureId: '99' },
    { ...active, source: 'MANUAL' }, { ...active, remark: 'another fixture' },
    { ...active, status: 'HANDLED' }
  ]) assert.throws(() => assertProductionAndon(row, expected, 'ACTIVE'))
  assert.match(production003, /andon-create-committed/)
  assert.ok(production003.indexOf('assertProductionAndon(unwrap(active)') <
    production003.indexOf("api.putBusiness('/mes/andon-record/respond'"))
  assert.ok(production003.indexOf('persisted.available') <
    production003.indexOf("api.putBusiness('/mes/andon-record/respond'"))
  assert.ok(production003.indexOf("transitions.push({ stage: 'HANDLED'") <
    production003.indexOf("name: '安灯正式 create/respond/handle 状态链路可回读'"))
})

test('production negative prerequisites isolate the target gate and preserve cleanup evidence', () => {
  assert.match(production001, /withTeam: false,\s*withOpeningInventory: true/)
  assert.match(production001, /未配工艺排产被拒绝且不产生孤立任务/)
  assert.match(production001, /mergeProductionFixtureEvidence\(caseRecord, negativeRecord\)/)
  assert.match(production002, /voidOpeningInventoryForShortage\(noStockRecord\)/)
  assert.match(production002, /noStockMaterial != null && Number\(noStockMaterial.requiredQty\) > 0/)
  assert.doesNotMatch(production002, /stockQty \|\| 0/)
  assert.match(production002, /mergeProductionFixtureEvidence\(caseRecord, noStockRecord\)/)
})

test('missing process inspection retains real source diagnostics without mutating shared quality settings', () => {
  assert.match(production004, /process-quality-source-diagnostic/)
  assert.match(production004, /custom_field8=/)
  assert.match(production004, /productionQualityDiagnostic/)
  assert.match(production004, /Number\(report.isEffective\) === 0 && fixture.outputIds.length === 0/)
  assert.doesNotMatch(source, /configData:|saveOrUpdateConfig|is_auto_check\s*:/)
})

test('production errors, malformed pages and inconsistent totals cannot become empty prerequisites', () => {
  for (const result of [
    undefined,
    { code: 200, success: false, data: { records: [], total: 0 } },
    { code: 404, data: { records: [], total: 0 } },
    { code: 0, data: null },
    { code: 0, data: { total: 0 } },
    { code: 0, data: { records: [], total: 1 } },
    { code: 0, data: { records: [{ id: '1' }], total: 0 } },
    { code: 0, data: { records: [{}], total: 1 } },
    { code: 0, data: { records: Array.from({ length: 101 }, (_, id) => ({ id })), total: 101 } }
  ]) {
    assert.throws(() => productionPageRows(result, 'work'), /不能视为缺少正式单据/)
  }
})

test('production fixtures use an owned chain instead of stale shared IDs', () => {
  assert.equal(isMissingProductionWork({ code: 500, msg: '工单不存在' }), true)
  for (const result of [
    undefined,
    { code: 0 },
    { code: 200, success: true },
    { code: 404, msg: '请求地址不存在' },
    { code: 500, msg: '工单编号为空' },
    { code: 500, msg: '系统异常' }
  ]) {
    assert.equal(isMissingProductionWork(result), false)
  }
  assert.match(production001, /new ExecutionWorkflowFixture\(api, record, caseId/)
  assert.match(production001, /await fixture\.setup\(caseRecord\)/)
  assert.match(production001, /fixture\.cleanup\(caseRecord\)/)
  assert.match(production001, /未配置班组时预排产被正式阻断/)
  assert.doesNotMatch(production001, /__not_exists__|routeproducetask/)
  assert.match(production002, /withFeed: true/)
  assert.match(production002, /await fixture\.prepareFeed\(caseRecord\)/)
  assert.match(executionFixtureSource, /feed-pick-preview/)
  assert.match(production002, /generate-pick-bill/)
  assert.match(executionFixtureSource, /['"]\/mes\/stkIo\/check/)
  assert.match(executionFixtureSource, /['"]\/mes\/prodWorkTask\/feed-record/)
  assert.match(production002, /无库存时生成生产领料单被正式拒绝/)
  assert.match(production004, /withQuality: true/)
  assert.match(production004, /createFailedDetailAndAudit/)
  assert.match(production004, /required-item-gate/)
  assert.match(production004, /qualityInspection\/recheck/)
  assert.match(production004, /prodWorkReport\/check/)
  assert.match(production004, /requireInventory: true/)
  assert.match(executionFixtureSource, /['"]\/mes\/prodWork\/finish/)
  assert.doesNotMatch(production004, /prodOrder\/close-check|processGate/)
  assert.match(production006, /release-gate\?prodOrderId=.*fixture\.order\.id/)
  assert.match(production006, /expectedBusinessRejection: missingOrderRejection/)
  assert.match(production007, /close-check\?id=.*fixture\.order\.id/)
  assert.match(production007, /expectedBusinessRejection: missingOrderRejection/)
})

test('production pages wait for real page controls, not sidebar workbench text', () => {
  assert.match(production001, /openRoute\(page, '\/mes\/produce\/order', \{/)
  assert.match(production001, /readySelector: '\.search-form input\[placeholder="请输入计划单号"\]'/)
  assert.match(production002, /openRoute\(page, '\/mes\/produce\/work-order', \{/)
  assert.match(production002, /readySelector: '\.search-form input\[placeholder="请输入工单编号"\]'/)
})

test('MES-PROD-004 uses the quality gate and WMS output closure, not the production-order close gate', () => {
  assert.match(production004, /required-item-gate/)
  assert.match(production004, /\/mes\/prodWorkReport\/check/)
  assert.match(production004, /\/mes\/stkIo\/queryById/)
  assert.match(production004, /\/mes\/stkInventory\/list/)
  assert.match(production004, /\/wms\/operation\/task\/page/)
  assert.match(production004, /WMS 收货已完成且生成待执行上架任务/)
  assert.match(executionFixtureSource, /['"]\/mes\/prodWork\/finish/)
  assert.match(production004, /partial: !complete/)
  assert.match(production004, /const blockedFinish = await api.request\('POST', '\/mes\/prodWork\/finish'/)
  assert.match(production004, /Number\(blockedWork.status\) === 2/)
  assert.match(production004, /assert\(finishBlocked/)
  assert.doesNotMatch(production004, /closeCheckResponse|qualityGate|processGate/)
})

test('MES-PROD-004 imports every runtime helper used by its quality and WMS closure', async () => {
  assert.match(source, /import assert from 'node:assert\/strict'/)
  assert.match(source, /dataOf as unwrap/)
  assert.match(source, /import \{\s*createFailedDetailAndAudit,\s*dataOf as unwrap,\s*rowsOf\s*\}/s)
  assert.match(production004, /unwrap\(await api\.getBusiness\(/)
  assert.match(production004, /rowsOf\(await api\.getBusiness\(/)
  assert.match(production004, /assert\.equal\(/)

  // Importing the suite exercises module resolution without starting a browser,
  // API client, backend, or database write.
  const module = await import('../suites/mes-production.mjs')
  assert.deepEqual(module.cases.slice(0, 4), [
    'MES-PROD-001',
    'MES-PROD-002',
    'MES-PROD-003',
    'MES-PROD-004'
  ])
})

test('production write-side closures use formal APIs and retain only explicit catalog gaps', () => {
  assert.match(production001, /partial: true/)
  assert.match(production002, /partial: true/)
  assert.match(production004, /partial: !complete/)
  assert.equal(caseOutcome({
    failedChecks: [], hasAssertions: true, result: { partial: true }
  }).status, 'PARTIAL')
  assert.equal(caseOutcome({
    failedChecks: [], hasAssertions: true, result: { partial: false }
  }).status, 'PASS')
  assert.equal(caseOutcome({
    failedChecks: [{ passed: false }], hasAssertions: true, result: { partial: true }
  }).status, 'FAIL')
})

test('original material mode, finish and WMS task assertions cannot be satisfied by weaker API evidence', () => {
  const feedNames = [
    '投料预览返回真实 BOM 物料、来源明细和数量',
    '生产领料单经 WMS 正式审核并保留来源与明细',
    '重复生成生产领料单被正式拒绝且不新增单据',
    '重复投料超过已领未投余额被正式拒绝'
  ]
  const feed = { checks: feedNames.map((name) => ({ name, passed: true, details: 'facts' })) }
  assert.equal(finalizeProductionCatalogEvidence(feed, 'MES-PROD-002'), false)
  assert.match(feed.catalogAssertions[0].details, /物料级领料方式/)
  assert.equal(feed.catalogAssertions[4].status, 'VERIFIED')
  const qualityNames = [
    '过程检不合格时必检门禁阻断报工审核与完工流转',
    '不合格过程检审核报工被正式拒绝',
    '过程检放行后生成104成品入库并回读来源',
    'WMS 收货已完成且生成待执行上架任务',
    '工单 stockedNum 和实际交期回写',
    '工单完工状态切换保留入库实际交期'
  ]
  const quality = { checks: qualityNames.map((name) => ({ name, passed: true, details: 'facts' })) }
  assert.equal(finalizeProductionCatalogEvidence(quality, 'MES-PROD-004'), false)
  assert.equal(quality.catalogAssertions[0].status, 'GAP')
  assert.equal(quality.catalogAssertions[2].status, 'GAP')
  assert.match(quality.catalogAssertions[2].details, /pendingPutawayQty=0/)
  quality.checks.push({
    name: '不合格过程检工单完工被正式拒绝且状态未变', passed: true, details: 'state=2'
  })
  assert.equal(finalizeProductionCatalogEvidence(quality, 'MES-PROD-004'), false)
  assert.equal(quality.catalogAssertions[0].status, 'VERIFIED')
  assert.equal(quality.remainingAssertions.length, 1)
  quality.checks.push({ name: 'cleanup failed', passed: false, details: 'retained' })
  finalizeProductionCatalogEvidence(quality, 'MES-PROD-004')
  assert.equal(quality.passCandidate, false)
})

test('MES-PROD-007 maps every original assertion including cost-only manual release', () => {
  assert.match(production007, /productionCloseChecks\(closeCheck, fixture.order.id\)/)
  assert.match(production007, /成本项未通过且明确要求人工放行/)
  assert.match(production007, /finalizeProductionCatalogEvidence\(caseRecord, caseId\)/)
  const record = { checks: [
    '专属生产订单结案检查清单包含四项门禁且不重复',
    '专属结案结论与人工放行清单口径一致',
    '不存在的生产订单结案请求被明确拒绝'
  ].map((name) => ({ name, passed: true, details: 'facts' })) }
  assert.equal(finalizeProductionCatalogEvidence(record, 'MES-PROD-007'), false)
  assert.equal(record.remainingAssertions.length, 1)
  assert.match(record.remainingAssertions[0].assertion, /成本项/)
  record.checks.push({ name: '成本项未通过且明确要求人工放行', passed: true, details: 'FMS unavailable' })
  assert.equal(finalizeProductionCatalogEvidence(record, 'MES-PROD-007'), true)
})

test('production catalog evidence maps actual write-side checks and does not fabricate unsupported sales/BPM semantics', () => {
  const record = {
    checks: [
      { name: '专属生产订单审核后拆分出唯一工单', passed: true, details: 'work=1' },
      { name: '专属工单排产生成唯一专属任务', passed: true, details: 'task=1' },
      { name: '未配工艺排产被拒绝且不产生孤立任务', passed: true, details: 'code=500; tasks=0' },
      { name: '未配置班组时预排产被正式阻断', passed: true, details: 'code=500' }
    ]
  }
  assert.equal(finalizeProductionCatalogEvidence(record, 'MES-PROD-001'), false)
  assert.equal(record.catalogAssertions[0].status, 'GAP')
  assert.deepEqual(record.catalogAssertions.slice(1).map((item) => item.status), [
    'VERIFIED', 'VERIFIED', 'VERIFIED'
  ])
  assert.match(record.remainingAssertions[0].assertion, /销售订单选单/)
})
