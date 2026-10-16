import assert from 'node:assert/strict'
import {
  EVALUATION_ACCEPTANCE_GAPS,
  cleanupEvaluationFixtures,
  createOwnedEvaluationTemplate,
  disableEvaluationConfig,
  evaluationId,
  evaluateOwnedTicket,
  newEvaluationFixture,
  prepareEvaluationFixtures,
  readEvaluationConfig,
  verifyEvaluationItemProtection,
  verifyEvaluationVersionFreeze
} from './project-after-sales-evaluation-closure.mjs'
import {
  assertEvaluationItemForm,
  assertEvaluationItemReadback,
  assertEvaluationTemplateRows,
  savePb128EvaluationItem,
  verifyPb129TemplatePage
} from './project-after-sales-evaluation-browser.mjs'

const sources = Object.freeze({
  'PB128-001': [
    ['PB128/stable-code-and-reference-protection', 'PB128/cleanup'],
    ['PB128/browser-save-reload-all-fields', 'PB128/cleanup'],
    ['PB128/formal-evaluation-frozen-version', 'PB128/cleanup']
  ],
  'PB129-001': [
    ['PB129/complete-v1-snapshot-frozen', 'PB129/new-version-has-changed-content', 'PB129/cleanup'],
    ['PB129/formal-evaluation-frozen-version', 'PB129/historical-statistics-unchanged', 'PB129/cleanup'],
    ['PB129/enabled-template-reference-protection', 'PB129/cleanup']
  ]
})
const check = (record, name, details) => {
  record.checks.push({ name, passed: true, details })
}

export const appendEvaluationGapEvidence = (record, caseId) => {
  assert.ok(Object.hasOwn(EVALUATION_ACCEPTANCE_GAPS, caseId))
  assert.ok(Array.isArray(record.checks), 'missing case checks')
  if (!Array.isArray(record.catalogAssertions)) record.catalogAssertions = []
  const gaps = EVALUATION_ACCEPTANCE_GAPS[caseId]
  const prefix = caseId.slice(0, 5)
  const rows = gaps.map((gap, position) => {
    const evidence = sources[caseId][position]
    const validNames = evidence.length > 0 && new Set(evidence).size === evidence.length &&
      evidence.every((name) => name.startsWith(`${prefix}/`))
    const found = evidence.map((name) => record.checks.filter((item) => item.name === name))
    const passed = validNames && found.every((items) => items.length === 1 && items[0].passed === true)
    record.checks.push({
      name: gap.check, passed,
      details: evidence.map((name, index) =>
        `${name}: ${found[index].length === 1 ? found[index][0].details : 'missing unique case evidence'}`).join('; ')
    })
    let row = record.catalogAssertions.find((item) => item.assertion === gap.assertion)
    if (!row) {
      row = { index: record.catalogAssertions.length, assertion: gap.assertion }
      record.catalogAssertions.push(row)
    }
    const aggregate = record.checks.filter((item) => item.name === gap.check)
    row.evidenceChecks = [gap.check]
    row.status = aggregate.length === 1 && aggregate[0].passed === true ? 'VERIFIED' : 'GAP'
    row.details = aggregate.length === 1 ? aggregate[0].details : 'duplicate gap evidence'
    return row
  })
  record.acceptanceGapAssertions = rows
  record.remainingAssertions = record.catalogAssertions.filter((row) => row.status !== 'VERIFIED')
    .map((row) => row.assertion)
  return rows
}

export const runEvaluationClosureCase = async (
  { caseId, api, page, caseRecord, capture = async () => {}, fixture = newEvaluationFixture(caseId) },
  {
    saveItem = savePb128EvaluationItem,
    verifyTemplatePage = verifyPb129TemplatePage,
    readSql
  } = {}
) => {
  assert.equal(fixture.caseId, caseId, 'cannot borrow another evaluation case fixture')
  assert.equal(fixture.resources.length, 0, 'evaluation case requires a fresh dedicated fixture')
  assert.ok(!fixture.materialId && !fixture.assetId && !fixture.ticketId, 'cannot reuse existing business references')
  caseRecord.evaluationFixture = fixture
  const prefix = fixture.prefix
  const errors = []
  let result
  try {
    await prepareEvaluationFixtures(api, fixture)
    const choice = fixture.items[2]
    const initial = await readEvaluationConfig(api, fixture, choice)
    assert.equal(initial.itemCode, choice.body.itemCode)
    assert.equal(evaluationId(initial.categoryId), choice.body.categoryId)
    assert.equal(initial.status, 'ENABLED')
    if (caseId === 'PB128-001') {
      check(caseRecord, '评价项目主档写入后回读稳定编码与分类引用',
        `itemId=${choice.id}; code=${initial.itemCode}; categoryId=${initial.categoryId}`)
      const expected = {
        ...choice.body, categoryId: fixture.alternateCategory.id,
        itemName: `${fixture.marker}-PAGE-SAVED`, evaluationType: 'MULTIPLE',
        options: ['FOLLOW_UP', 'SATISFIED', 'UNSATISFIED'],
        maxScore: 70, required: true, sortNo: 0
      }
      const browser = await saveItem(page, api, fixture, choice, expected, { capture })
      assertEvaluationItemForm(browser.form, expected, fixture.alternateCategory.body.categoryName)
      assertEvaluationItemReadback(browser.saved, choice, expected)
      assertEvaluationItemReadback(browser.persisted, choice, expected)
      assert.deepEqual(browser.saved, browser.persisted)
      assertEvaluationItemReadback(await readEvaluationConfig(api, fixture, choice), choice, expected)
      choice.body = structuredClone(expected)
      check(caseRecord, 'PB128/browser-save-reload-all-fields',
        `itemId=${choice.id}; fields=category,type,options,required,maxScore,code,name; cleared page-local state and reloaded`)
    }
    const v1 = await createOwnedEvaluationTemplate(api, fixture)
    if (caseId === 'PB129-001') {
      check(caseRecord, '评价模板启用后回读项目快照与总分', JSON.stringify(v1.snapshot))
      const beforeRows = await verifyTemplatePage(page, fixture, v1, {
        capture: (label) => capture(`${label}-before-master-change`)
      })
      assertEvaluationTemplateRows(beforeRows, v1.snapshot)
      check(caseRecord, 'PB129/template-page-before-master-change',
        `templateId=${v1.id}; version=${v1.body.versionNo}; rows=${beforeRows.length}`)
    }
    await verifyEvaluationItemProtection(api, fixture, choice, v1, caseId === 'PB128-001')
    check(caseRecord, caseId === 'PB128-001'
      ? 'PB128/stable-code-and-reference-protection' : 'PB129/enabled-template-reference-protection',
    `itemId=${choice.id}; templateId=${v1.id}; exact rejection; unchanged item, revisions and complete template`)
    const evaluation = await evaluateOwnedTicket(api, fixture, v1)
    check(caseRecord, `${prefix}/formal-evaluation-frozen-version`,
      `ticketId=${fixture.ticketId}; evaluationId=${evaluation.id}; templateId=${v1.id}; version=V1; complete snapshot readback`)
    if (caseId === 'PB129-001') {
      result = await verifyEvaluationVersionFreeze(api, fixture, v1)
      check(caseRecord, 'PB129/complete-v1-snapshot-frozen', JSON.stringify(result.v1))
      check(caseRecord, 'PB129/new-version-has-changed-content', JSON.stringify(result.v2))
      check(caseRecord, 'PB129/historical-statistics-unchanged', JSON.stringify(result.statistics))
      check(caseRecord, '已启用模板保留创建时快照，不随评价项目主档漂移',
        `V1=${v1.id}; V2=${result.v2.templateId}; complete names/types/options/order/scores/required unchanged`)
      const afterRows = await verifyTemplatePage(page, fixture, v1, {
        capture: (label) => capture(`${label}-after-new-version`)
      })
      assertEvaluationTemplateRows(afterRows, v1.snapshot)
      check(caseRecord, 'PB129/template-page-after-new-version',
        `templateId=${v1.id}; version=V1; old frozen content displayed after local-state clear and reload`)
    } else {
      const disabled = await disableEvaluationConfig(api, fixture, choice)
      assert.equal(disabled.itemCode, initial.itemCode)
      check(caseRecord, '评价项目停用后回读为 DISABLED 且编码不变',
        `itemId=${choice.id}; code=${disabled.itemCode}; status=${disabled.status}`)
      result = { evaluation, snapshot: v1.snapshot }
    }
  } catch (error) {
    errors.push(error)
  } finally {
    try {
      const cleanup = await cleanupEvaluationFixtures(api, fixture, readSql)
      check(caseRecord, `${prefix}/cleanup`, JSON.stringify(cleanup))
      caseRecord.notes.push(`${prefix}: owned asset retired and configs disabled; customer, closed ticket, evaluation and referenced material retained for audit.`)
    } catch (error) {
      errors.push(error)
      caseRecord.checks.push({ name: `${prefix}/cleanup`, passed: false, details: error.message })
    }
    appendEvaluationGapEvidence(caseRecord, caseId)
  }
  if (errors.length) {
    throw new AggregateError(errors,
      `${prefix} evaluation closure failed: ${errors.map((error) => error.message).join('; ')}`)
  }
  return {
    fixture, result, partial: caseRecord.acceptanceGapAssertions.some((row) => row.status !== 'VERIFIED')
  }
}
