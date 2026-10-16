import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildDedicatedProjectHandoverPayload,
  finalizeProjectAfterSalesCatalogAssertions,
  futureQuarterFixture,
  hasProjectFixture,
  initializeProjectAfterSalesCatalogAssertions,
  isoWeekKey,
  isDedicatedProject,
  isBusinessRejected,
  markProjectAfterSalesCatalogAssertion,
  parseRiskLevelHistory,
  PROJECT_AFTER_SALES_ACCEPTANCE_GAPS,
  PROJECT_REPORT_DEFINITIONS,
  resolveReportPeriodRange,
  validTaskLibraryConfig
} from '../suites/project-after-sales.mjs'

test('project-after-sales recognizes business rejection in an HTTP-success response', () => {
  assert.equal(
    isBusinessRejected({ code: 400, data: null, msg: '引用中不能删除' }, 400, '不能删除'),
    true
  )
  assert.equal(isBusinessRejected({ code: 0, data: true }, 400, '不能删除'), false)
  assert.equal(isBusinessRejected({ code: 200, success: true, data: true }, 400, '不能删除'), false)
})

test('project-after-sales distinguishes missing project facts from a failed page response', () => {
  assert.equal(hasProjectFixture({ code: 0, data: { list: [] } }), false)
  assert.equal(hasProjectFixture({ code: 0, data: { list: [{ id: 1 }] } }), true)
  assert.equal(hasProjectFixture({ code: 0, data: [] }), false)
})

test('task library accepts backend aliases and optional dependencies', () => {
  const task = { code: 'T1', name: '任务', standardHours: 8, deliverable: '方案', acceptance: '评审' }
  assert.equal(validTaskLibraryConfig({ tasks: [task] }), true)
  assert.equal(validTaskLibraryConfig({
    items: [{
      taskCode: 'T1', taskName: '任务', standardHours: 8,
      requiredOutput: '方案', acceptanceCriteria: '评审', predecessorIds: null
    }]
  }), true)
  assert.equal(validTaskLibraryConfig({ tasks: [task, { ...task, acceptance: '' }] }), false)
  assert.equal(validTaskLibraryConfig({ tasks: [{ ...task, predecessors: 'T0' }] }), false)
  assert.equal(validTaskLibraryConfig({ tasks: [] }), false)
  assert.equal(validTaskLibraryConfig({}), false)
})

test('dedicated project handover uses the formal empty-project create contract', () => {
  const payload = buildDedicatedProjectHandoverPayload({
    marker: 'E2E_PB117_PROJECT_ABC',
    projectType: 'TYPE_DEPENDENCY'
  })
  assert.deepEqual(payload, {
    sourceType: 'MANUAL',
    sourceBusinessNo: 'E2E_PB117_PROJECT_ABC',
    projectName: 'E2E_PB117_PROJECT_ABC 专属空项目',
    projectType: 'TYPE_DEPENDENCY',
    customerNameSnapshot: 'E2E_PB117_PROJECT_ABC',
    scopeIn: 'E2E_PB117_PROJECT_ABC',
    commitments: 'E2E_PB117_PROJECT_ABC',
    acceptanceConditions: 'E2E_PB117_PROJECT_ABC',
    initialRisks: 'E2E_PB117_PROJECT_ABC'
  })
})

test('dedicated project cleanup guard requires exact project and handover ownership', () => {
  const fixture = { projectId: '101', handoverId: '202', marker: 'E2E_PROJECT' }
  assert.equal(isDedicatedProject({ id: 101, handoverId: 202, customerNameSnapshot: 'E2E_PROJECT' }, fixture), true)
  assert.equal(isDedicatedProject({ id: 101, handoverId: 303, customerNameSnapshot: 'E2E_PROJECT' }, fixture), false)
  assert.equal(isDedicatedProject({ id: 999, handoverId: 202, customerNameSnapshot: 'E2E_PROJECT' }, fixture), false)
})

test('PB117 and PB118 do not select or restore the first shared project', () => {
  const suite = readFileSync(
    fileURLToPath(new URL('../suites/project-after-sales.mjs', import.meta.url)),
    'utf8'
  )
  assert.doesNotMatch(suite, /const sampleProject\s*=\s*listOf\(projectPage\)\[0\]/)
  assert.doesNotMatch(suite, /const project\s*=\s*listOf\(pageData\)\[0\]/)
  assert.match(suite, /'\/pm\/handover\/create'/)
  assert.match(suite, /restoreDedicatedProject\(api, fixture\)/)
})

test('PB945 report period keys resolve daily, ISO week and natural month ranges', () => {
  assert.deepEqual(resolveReportPeriodRange('DAILY', '2026-10-09'), ['2026-10-09', '2026-10-09'])
  assert.equal(isoWeekKey('2026-10-09'), '2026-W41')
  assert.deepEqual(resolveReportPeriodRange('WEEKLY', '2026-W41'), ['2026-10-05', '2026-10-11'])
  assert.deepEqual(resolveReportPeriodRange('MONTHLY', '2026-10'), ['2026-10-01', '2026-10-31'])
  assert.deepEqual(resolveReportPeriodRange('MONTHLY', '2024-02'), ['2024-02-01', '2024-02-29'])
  assert.equal(resolveReportPeriodRange('DAILY', '2026-10'), null)
  assert.equal(resolveReportPeriodRange('WEEKLY', '2026-W99'), null)
  assert.equal(resolveReportPeriodRange('MONTHLY', '2026-13'), null)
})

test('PB947 risk history parser keeps only valid array snapshots', () => {
  const history = [
    { previousLevel: 'LOW', currentLevel: 'HIGH', changedTime: '2026-10-09T10:00:00' }
  ]
  assert.deepEqual(parseRiskLevelHistory(JSON.stringify(history)), history)
  assert.deepEqual(parseRiskLevelHistory('{"previousLevel":"LOW"}'), [])
  assert.deepEqual(parseRiskLevelHistory('not-json'), [])
  assert.deepEqual(parseRiskLevelHistory(null), [])
})

test('PB953 report definitions cover the eleven report routes with unique type/path pairs', () => {
  assert.equal(PROJECT_REPORT_DEFINITIONS.length, 11)
  assert.equal(new Set(PROJECT_REPORT_DEFINITIONS.map((item) => item.reportType)).size, 11)
  assert.equal(new Set(PROJECT_REPORT_DEFINITIONS.map((item) => item.path)).size, 11)
  assert.deepEqual(
    PROJECT_REPORT_DEFINITIONS.map((item) => item.reportType),
    [
      'PROJECT_PROGRESS',
      'TASK_EXECUTION',
      'RESEARCH',
      'RISK_ISSUE_BUG',
      'PLAN_CHANGE',
      'RELEASE',
      'GO_LIVE_ISSUE',
      'ACCEPTANCE_RECTIFICATION',
      'PROJECT_REVIEW',
      'AFTER_SALES_HANDOVER',
      'PROJECT_CLOSEOUT'
    ]
  )
})

test('catalog assertions stay incomplete until every mapped assertion is verified', () => {
  const record = {
    checks: [
      { name: '交付项目分页可读', passed: false, details: '业务返回 500' },
      { name: '非法健康状态被拒绝，核心状态与健康状态解耦', passed: true, details: 'ok' },
      { name: '健康状态可独立切换为 DELAYED 且核心状态不变', passed: true, details: 'ok' }
    ],
    notes: []
  }
  initializeProjectAfterSalesCatalogAssertions(record, 'PB118-001')
  assert.equal(record.catalogAssertions.length, 3)
  assert.equal(record.catalogComplete, false)
  assert.equal(markProjectAfterSalesCatalogAssertion(record, 0, ['交付项目分页可读']), false)
  assert.equal(markProjectAfterSalesCatalogAssertion(record, 1, ['缺失的断言']), false)
  const result = finalizeProjectAfterSalesCatalogAssertions(record, 'PB118-001', { partial: true })
  assert.equal(result.catalogComplete, false)
  assert.equal(result.acceptanceComplete, false)
  assert.equal(record.passCandidate, false)
  assert.equal(result.remainingAssertions.length, 4)
  assert.equal(record.acceptanceGapAssertions.length, 3)
  assert.ok(record.notes.some((note) => note.includes('catalog 断言未验证')))
})

test('catalog assertions complete only when all evidence checks passed', () => {
  const record = {
    checks: [
      { name: '手工客户资产可在分页中按 assetNo 独立检索', passed: true, details: 'ok' },
      { name: '客户资产详情统一回读服务期、责任人和存货档案引用', passed: true, details: 'ok' },
      { name: '客户资产不是存货余额载体，不含库存数量字段', passed: true, details: 'ok' },
      { name: '资产退役后状态回读为 RETIRED，不改动存货档案', passed: true, details: 'ok' }
    ],
    notes: []
  }
  record.checks.push(...PROJECT_AFTER_SALES_ACCEPTANCE_GAPS['PB125-001'].map((gap) => ({
    name: gap.check, passed: true, details: 'PB125 dedicated complete evidence'
  })))
  initializeProjectAfterSalesCatalogAssertions(record, 'PB125-001')
  const result = finalizeProjectAfterSalesCatalogAssertions(record, 'PB125-001')
  assert.equal(result.catalogComplete, true)
  assert.equal(result.acceptanceComplete, true)
  assert.equal(result.passCandidate, true)
  assert.equal(record.passCandidate, true)
  assert.equal(result.partial, false)
  assert.deepEqual(result.remainingAssertions, [])
  assert.equal(record.acceptanceGapAssertions.length, 3)
})

test('complete catalog cannot mask partial, unimplemented, blocked or failed checks', () => {
  const originalChecks = [
    '手工客户资产可在分页中按 assetNo 独立检索',
    '客户资产详情统一回读服务期、责任人和存货档案引用',
    '客户资产不是存货余额载体，不含库存数量字段',
    '资产退役后状态回读为 RETIRED，不改动存货档案'
  ]
  for (const scenario of [
    { result: { partial: true } },
    { result: { notImplemented: true } },
    { result: { designed: true } },
    { result: { blocked: true } },
    { result: { skipped: true } },
    { extra: { name: 'cleanup', passed: false } },
    { extra: { name: 'cleanup', passed: 'true' } },
    { extra: { name: 'cleanup' } }
  ]) {
    const record = {
      checks: [
        ...originalChecks.map((name) => ({ name, passed: true, details: 'ok' })),
        ...PROJECT_AFTER_SALES_ACCEPTANCE_GAPS['PB125-001'].map((gap) => ({
          name: gap.check, passed: true, details: 'complete dedicated gap evidence'
        })),
        ...(scenario.extra ? [scenario.extra] : [])
      ],
      notes: [],
      passCandidate: true
    }
    const result = finalizeProjectAfterSalesCatalogAssertions(record, 'PB125-001', scenario.result)
    assert.equal(result.catalogComplete, true)
    assert.equal(record.passCandidate, false)
    assert.equal(result.passCandidate, false)
    assert.equal(result.acceptanceComplete, false)
  }
})

test('catalog assertions reject empty, duplicate, blank and non-string evidence names', () => {
  for (const names of [[], ['', ''], [''], [' '], [null], [undefined], [125], ['named', 'named']]) {
    const record = {
      checks: [...new Set(names)].map((name) => ({ name, passed: true, details: 'invalid naming' })),
      notes: []
    }
    initializeProjectAfterSalesCatalogAssertions(record, 'PB125-001')
    assert.equal(markProjectAfterSalesCatalogAssertion(record, 0, names), false)
    assert.equal(record.catalogAssertions[0].status, 'GAP')
  }
})

test('catalog completion can never hide a partial result from other checks', () => {
  const record = {
    checks: [
      { name: '手工客户资产可在分页中按 assetNo 独立检索', passed: true, details: 'ok' },
      { name: '客户资产详情统一回读服务期、责任人和存货档案引用', passed: true, details: 'ok' },
      { name: '客户资产不是存货余额载体，不含库存数量字段', passed: true, details: 'ok' },
      { name: '资产退役后状态回读为 RETIRED，不改动存货档案', passed: true, details: 'ok' }
    ],
    notes: []
  }
  initializeProjectAfterSalesCatalogAssertions(record, 'PB125-001')
  const result = finalizeProjectAfterSalesCatalogAssertions(record, 'PB125-001', { partial: true })
  assert.equal(result.catalogComplete, false)
  assert.equal(result.partial, true)
  assert.equal(result.acceptanceComplete, false)
  assert.ok(record.catalogAssertions.some((row) => row.status === 'GAP'))
})

test('PB120/PB125/PB130 append every original acceptanceGap verbatim with unique same-case checks', () => {
  const catalog = JSON.parse(readFileSync(
    fileURLToPath(new URL('../cases/catalog.json', import.meta.url)), 'utf8'))
  const suite = catalog.suites.find((item) => item.id === 'project-after-sales')
  for (const caseId of ['PB120-001', 'PB125-001', 'PB130-001']) {
    const definition = suite.cases.find((item) => item.id === caseId)
    const record = { checks: [], notes: definition.acceptanceGaps.map((gap) => `GAP: ${gap}`) }
    const result = finalizeProjectAfterSalesCatalogAssertions(record, caseId)
    assert.deepEqual(record.acceptanceGapAssertions.map((row) => row.assertion), definition.acceptanceGaps)
    assert.deepEqual(PROJECT_AFTER_SALES_ACCEPTANCE_GAPS[caseId].map((gap) => gap.assertion),
      definition.acceptanceGaps)
    assert.equal(result.acceptanceComplete, false)
    assert.equal(result.partial, true)
    const names = record.acceptanceGapAssertions.flatMap((row) => row.evidenceChecks)
    assert.equal(names.length, definition.acceptanceGaps.length)
    assert.equal(new Set(names).size, names.length)
    assert.ok(names.every((name) => name.startsWith(`${caseId.slice(0, 5)}/GAP`)))
    assert.ok(record.acceptanceGapAssertions.every((row) => row.status === 'GAP'))
    assert.ok(!record.catalogAssertions.some((row) => row.assertion === '完整业务验收门禁（acceptanceGaps）'))
    assert.ok(definition.acceptanceGaps.every((gap) => record.notes.includes(`GAP: ${gap}`)))
    finalizeProjectAfterSalesCatalogAssertions(record, caseId)
    assert.equal(record.acceptanceGapAssertions.length, definition.acceptanceGaps.length)
  }
})

test('acceptanceGap evidence cannot be borrowed from another case or duplicate/failed names', () => {
  const gap = PROJECT_AFTER_SALES_ACCEPTANCE_GAPS['PB125-001'][0]
  for (const checks of [
    [{ name: PROJECT_AFTER_SALES_ACCEPTANCE_GAPS['PB130-001'][0].check, passed: true }],
    [{ name: gap.check, passed: false }],
    [{ name: gap.check, passed: 'true' }],
    [{ name: gap.check }],
    [{ name: gap.check, passed: true }, { name: gap.check, passed: true }],
    [{ name: gap.check, passed: true }, { name: gap.check, passed: false }]
  ]) {
    const record = { checks, notes: [`GAP: ${gap.assertion}`] }
    finalizeProjectAfterSalesCatalogAssertions(record, 'PB125-001')
    assert.equal(record.acceptanceGapAssertions[0].status, 'GAP')
    assert.ok(record.notes.includes(`GAP: ${gap.assertion}`))
  }
  const record = { checks: [{ name: gap.check, passed: true, details: 'owned inventory snapshots' }],
    notes: [`GAP: ${gap.assertion}`] }
  finalizeProjectAfterSalesCatalogAssertions(record, 'PB125-001')
  assert.equal(record.acceptanceGapAssertions[0].status, 'VERIFIED')
  assert.ok(!record.notes.includes(`GAP: ${gap.assertion}`))
  assert.equal(record.acceptanceGapAssertions[1].status, 'GAP')
})

test('PB125 original catalog checks alone never complete its three acceptanceGap gates', () => {
  const checks = [
    '手工客户资产可在分页中按 assetNo 独立检索',
    '客户资产详情统一回读服务期、责任人和存货档案引用',
    '客户资产不是存货余额载体，不含库存数量字段',
    '资产退役后状态回读为 RETIRED，不改动存货档案'
  ].map((name) => ({ name, passed: true, details: 'original catalog only' }))
  const record = { checks, notes: [] }
  const result = finalizeProjectAfterSalesCatalogAssertions(record, 'PB125-001')
  assert.equal(result.catalogComplete, false)
  assert.equal(result.acceptanceComplete, false)
  assert.equal(record.passCandidate, false)
  assert.equal(result.remainingAssertions.length, 3)
  assert.deepEqual(record.acceptanceGapAssertions.map((row) => row.status), ['GAP', 'GAP', 'GAP'])
})

test('PB125 missing a cleanup or inventory stage cannot produce its dedicated gap evidence', () => {
  const suite = readFileSync(
    fileURLToPath(new URL('../suites/project-after-sales.mjs', import.meta.url)), 'utf8')
  const block = suite.slice(suite.indexOf("if (caseId === 'PB125-001')"),
    suite.indexOf("if (caseId === 'PB127-001')"))
  assert.match(block, /cleanupComplete && stages\.length === 7/)
  assert.match(block, /readPb125InventoryFacts\(api, fixture\)/)
  assert.match(block, /verifyPb125ExpiredAcceptance\(api, fixture\)/)
  assert.match(block, /verifyPb125StatusEvents\(fixture, active\)/)
  assert.doesNotMatch(block, /firstEnabledMaterialId|createProjectAcceptanceAssetFixture|PB127\/GAP/)
})

test('PB123 and PB124 without executable catalog assertions never claim completion', () => {
  for (const caseId of ['PB123-001', 'PB124-001']) {
    const record = { checks: [], notes: [] }
    initializeProjectAfterSalesCatalogAssertions(record, caseId)
    assert.equal(record.catalogAssertions.length, 0)
    const result = finalizeProjectAfterSalesCatalogAssertions(record, caseId)
    assert.equal(result.catalogComplete, false)
    assert.equal(result.partial, true)
    assert.equal(result.acceptanceComplete, false)
    assert.ok(record.notes.length > 0)
  }
})

test('PB123 suite only dispatches safe readiness on the same logged-in context, with no global knowledge writes', () => {
  const suite = readFileSync(
    fileURLToPath(new URL('../suites/project-after-sales.mjs', import.meta.url)), 'utf8')
  const start = suite.indexOf("if (caseId === 'PB123-001')")
  const block = suite.slice(start, suite.indexOf("if (caseId === 'PB124-001')", start))
  assert.match(block, /CFOR_E2E_WRITE_FIXTURES !== 'true'/)
  assert.match(block, /assertKnowledgeReadinessLocalContext\(config, config\.tenantId\)/)
  assert.match(block, /login\(args\.page, \{ returnContext: true \}\)/)
  assert.match(block, /args\.page\.context\(\)\.newPage\(\)/)
  assert.match(block, /runProjectAfterSalesKnowledgeReadiness\(/)
  assert.match(block, /passed: result\.auditSucceeded/)
  assert.match(block, /result\.negative\.matched && result\.negative\.unchanged/)
  assert.match(block, /finally \{\s+await knowledgePage\.close\(\)/)
  assert.doesNotMatch(block, /createApiClient|observePage|launchBrowser/)
  assert.doesNotMatch(suite, /knowledge-index\/run|waitForIndexedDocument|versionNo \?\? 1/)
  assert.doesNotMatch(suite, /knowledge\/policy\/(?:parse|libraries|topics)/)
})

test('PB953 also verifies legacy overview routes without treating module metadata as metric evidence', () => {
  const suite = readFileSync(
    fileURLToPath(new URL('../suites/project-after-sales.mjs', import.meta.url)), 'utf8')
  const block = suite.slice(suite.indexOf("if (caseId === 'PB953-001')"),
    suite.indexOf("if (caseId === 'PB955-001')"))
  assert.match(block, /verifyProjectReportPages\(/)
  assert.match(block, /\/project\/statistics\/workspace/)
  assert.match(block, /\/project\/statistics\/overview/)
  assert.match(block, /assertProjectReportPageText\(await page\.locator\('body'\)\.innerText\(\)\)/)
  assert.match(block, /title !== '过程报告'/)
  assert.match(block, /仅验证入口配置，不作为业务指标证据/)
})

test('PB124 real quiet-hour browser verification restores the dedicated rule before existing cleanup', () => {
  const suite = readFileSync(
    fileURLToPath(new URL('../suites/project-after-sales.mjs', import.meta.url)), 'utf8')
  const block = suite.slice(suite.indexOf("if (caseId === 'PB124-001')"),
    suite.indexOf("if (caseId === 'PB115-001')"))
  assert.match(block, /verifyReminderRuleQuietHoursInBrowser\(/)
  assert.match(block, /cleanup: 'restore'/)
  assert.match(block, /cleanupReminderClosure\(/)
  assert.match(block, /partial: true/)
  assert.match(block, /仍缺 worker 消费/)
})

test('futureQuarterFixture resolves the quarter and a future required finish time', () => {
  const fixture = futureQuarterFixture(30)
  const expected = new Date()
  expected.setDate(expected.getDate() + 30)
  const year = expected.getFullYear()
  const quarter = Math.floor(expected.getMonth() / 3) + 1
  assert.equal(fixture.quarterCode, `${year}Q${quarter}`)
  assert.equal(fixture.requiredFinishTime, `${expected.toISOString().slice(0, 10)} 18:00:00`)
})

test('catalog evidence stays scoped to each assertion instead of lighting up every row', () => {
  const suite = readFileSync(
    fileURLToPath(new URL('../suites/project-after-sales.mjs', import.meta.url)),
    'utf8'
  )
  const assertionBlock = suite.match(
    /const PROJECT_AFTER_SALES_ASSERTION_EVIDENCE = Object\.freeze\(\{([\s\S]*?)\n\}\)/
  )
  assert.ok(assertionBlock, '缺少 catalog 证据映射')
  const mappingSource = assertionBlock[1]
  const broadMapping = /checks:\s*\[[^\]]*,[^\]]*\]/
  assert.doesNotMatch(mappingSource, broadMapping, '单条证据不得包含多条检查名')
})
