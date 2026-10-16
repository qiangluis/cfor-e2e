import assert from 'node:assert/strict'
import { createDecipheriv } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { config } from '../config/index.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { observePage, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { ENCRYPT_HEADER, REQ_KEY } from '../lib/crypto.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { browserBusinessPayload } from './project-after-sales-browser.mjs'
import {
  assertPb951GatePrerequisites,
  assertPb951GateRejection,
  assertPmClosureLocalTarget,
  PROJECT_AFTER_SALES_CATALOG_ASSERTIONS
} from './project-after-sales-pm-closure.mjs'

export const PB951_PAGE_REMAINING_GATE =
  '里程碑确认页面展示实施计划确认清单，尚未接入 /pm/milestone 的准出条件、必需交付物和人工完成事实；本轮 API 闭环不能替代真实页面验收。'

export const PB951_CLOSURE_CHECKS = Object.freeze({
  fixture: '本轮正式交接审核建立专属项目并经四项基线进入执行',
  noExit: '缺少exitCondition时正式完成被拒绝且事实未变',
  noDeliverables: '缺少requiredDeliverablesJson时正式完成被拒绝且事实未变',
  entry: '计划页入口保留精确项目上下文且进入真实正式里程碑菜单',
  noExitUi: '页面缺准出条件禁止人工完成且不提供锁定编辑',
  noDeliverablesUi: '页面缺必需交付物禁止人工完成且不提供锁定编辑',
  save: '页面编辑通过正式save请求分别持久化准出条件和两个交付物',
  refresh: '刷新后编辑表单精确回显准出条件和两项交付物',
  confirm: '页面确认通过正式confirm接口锁定当前里程碑',
  blank: '空白人工结论在浏览器被拒绝且未产生完成请求',
  complete: '页面人工完成请求与正式回读精确匹配结论交付物和实际完成日期',
  list: '刷新后列表显示人工结论与日期并收起重复完成和编辑动作',
  detail: '正式详情清晰分开展示准出条件交付物系统健康预警人工结论和实际日期',
  layout: '窄屏详情弹窗和长结论内容不越出可视宽度',
  tasks: '里程碑人工完成不代替任务责任人确认或改写任务状态',
  database: '正式数据库行与页面人工结论和完成日期一致',
  browser: '浏览器无控制台页面异常请求失败或业务API错误'
})

const gateChecks = [
  'PB951 缺门禁负例在合法HRM工作日且确认状态和其它条件完整',
  '里程碑缺少准出条件或必需交付物时不能完成'
]
const completionCheck = '具备准出条件和交付物的里程碑可人工确认完成'
export const PB951_ORIGINAL_ASSERTIONS = Object.freeze([
  '缺少准出条件或必需交付物的里程碑不能完成',
  '具备门禁的里程碑确认后可人工完成',
  '完成回读人工结论、实际完成日期和必需交付物',
  '里程碑人工完成不代替任务责任人确认或改写任务状态'
])
const pageChecks = ['fixture', 'entry', 'noExitUi', 'noDeliverablesUi', 'save', 'refresh', 'confirm',
  'blank', 'complete', 'list', 'detail', 'layout', 'database', 'browser']
  .map((key) => PB951_CLOSURE_CHECKS[key])
const evidenceMappings = [
  gateChecks,
  [completionCheck],
  [completionCheck],
  [PB951_CLOSURE_CHECKS.tasks],
  pageChecks
]
const data = (response) => assertBusinessSuccess(response, 'PB951 formal API').data
const id = (value) => {
  assert.ok(typeof value === 'string' || Number.isSafeInteger(value), 'PB951 lossy ID')
  assert.match(String(value), /^[1-9]\d*$/, 'PB951 missing owned ID')
  return String(value)
}
const todayInShanghai = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())
const offsetDate = (day, offset) => {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}
const addCheck = (record, key, operation, details = '') => {
  operation()
  record.checks.push({ name: PB951_CLOSURE_CHECKS[key], passed: true, details })
}

export const registerMilestoneClosureAssertions = (caseRecord) => {
  const originals = PROJECT_AFTER_SALES_CATALOG_ASSERTIONS['PB951-001']
  assert.deepEqual(originals, PB951_ORIGINAL_ASSERTIONS,
    'PB951 catalog changed; review the original index/assertion mapping')
  caseRecord.catalogAssertions ??= originals.map((assertion, index) => ({
    index, assertion, status: 'GAP', evidenceChecks: [], details: '本轮尚未执行该原断言'
  }))
  originals.forEach((assertion, index) => {
    assert.equal(caseRecord.catalogAssertions[index]?.index, index, 'PB951 assertion index drift')
    assert.equal(caseRecord.catalogAssertions[index]?.assertion, assertion, 'PB951 assertion drift')
  })
  assert.equal(caseRecord.catalogAssertions.length, 4, 'PB951 must register the page gate once')
  caseRecord.catalogAssertions.push({
    index: 4, assertion: PB951_PAGE_REMAINING_GATE, status: 'GAP',
    evidenceChecks: [...pageChecks], details: '旧报告页面 remaining 门禁；本轮必须通过正式页面关闭'
  })
  caseRecord.remainingAssertions = caseRecord.catalogAssertions.map((row) => row.assertion)
  caseRecord.catalogComplete = false
}

const exactChecksPassed = (caseRecord, names) => names.every((name) => {
  const matches = caseRecord.checks.filter((check) => check.name === name)
  return matches.length === 1 && matches[0].passed === true
})

export const finalizeMilestoneClosureEvidence = (caseRecord) => {
  const addAggregate = (name, names) => {
    caseRecord.checks.push({
      name, passed: exactChecksPassed(caseRecord, names), details: names.join('；')
    })
  }
  for (const name of gateChecks) {
    addAggregate(name, [PB951_CLOSURE_CHECKS.noExit, PB951_CLOSURE_CHECKS.noDeliverables])
  }
  addAggregate(completionCheck, ['save', 'refresh', 'confirm', 'complete', 'list', 'detail', 'database']
    .map((key) => PB951_CLOSURE_CHECKS[key]))
  for (const [index, names] of evidenceMappings.entries()) {
    const row = caseRecord.catalogAssertions[index]
    assert.ok(row, 'PB951 missing registered catalog assertion')
    row.evidenceChecks = [...names]
    row.status = exactChecksPassed(caseRecord, names) ? 'VERIFIED' : 'GAP'
    row.details = names.map((name) => {
      const check = caseRecord.checks.find((item) => item.name === name)
      return `${name}: ${check?.details || (check?.passed === true ? 'PASS' : '缺少本轮证据')}`
    }).join('；')
  }
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((row) => row.status !== 'VERIFIED').map((row) => row.assertion)
  caseRecord.catalogComplete = caseRecord.remainingAssertions.length === 0
}

export const assertMilestoneProjectOwnership = (fixture, project = fixture?.project) => {
  assert.ok(fixture?.marker?.startsWith('E2E_PB951'), 'PB951 requires a dedicated marker')
  assert.equal(id(project?.id), id(fixture.projectId), 'PB951 project ownership mismatch')
  assert.equal(id(project?.handoverId), id(fixture.handoverId), 'PB951 handover mismatch')
  assert.equal(project.customerNameSnapshot, fixture.marker, 'PB951 project marker mismatch')
  assert.ok(project.projectCode, 'PB951 project code required for the real page')
  assert.equal(project.status, 'EXECUTING', 'PB951 requires the four confirmed baselines')
  id(fixture.ownerId)
}

export const readMilestoneTaskFacts = async (api, fixture, taskId, readSql = runReadOnlySql) => {
  assertMilestoneProjectOwnership(fixture)
  const projectId = id(fixture.projectId)
  const tasks = []
  let total
  for (let pageNo = 1; ; pageNo++) {
    const result = data(await api.getBusiness(
      `/pm/task/page?projectId=${projectId}&pageNo=${pageNo}&pageSize=100`
    ))
    assert.ok(Array.isArray(result?.list), 'PB951 missing task page')
    assert.ok(Number.isSafeInteger(result.total) && result.total >= 0, 'PB951 invalid task total')
    total ??= result.total
    assert.equal(result.total, total, 'PB951 task total changed during pagination')
    assert.ok(result.list.length <= 100, 'PB951 task page exceeds 100')
    tasks.push(...result.list)
    assert.ok(tasks.length <= total, 'PB951 task page exceeds total')
    if (tasks.length === total) break
    assert.ok(result.list.length, 'PB951 incomplete task pagination')
  }
  assert.equal(new Set(tasks.map((task) => id(task.id))).size, total, 'PB951 duplicate task IDs')
  for (const task of tasks) assert.equal(id(task.projectId), projectId, 'PB951 foreign task')
  tasks.sort((a, b) => id(a.id).localeCompare(id(b.id)))
  const task = data(await api.getBusiness(`/pm/task/get?id=${id(taskId)}`))
  assert.equal(id(task?.id), id(taskId))
  assert.equal(id(task.projectId), projectId, 'PB951 foreign protection task')
  const sql = await readSql(`SELECT id,status,owner_id,acceptance_owner_id,
    receive_time,completed_time FROM pm_project_task WHERE project_id=${projectId}
    AND tenant_id=1 AND deleted=0 ORDER BY id`)
  assert.equal(sql.available, true, 'PB951 requires actual database task evidence')
  assert.deepEqual(sql.rows.map((row) => id(row[0])).sort(), tasks.map((row) => id(row.id)).sort(),
    'PB951 SQL/API task identities differ')
  return { tasks, task, sql }
}

export const assertMilestoneTaskFactsUnchanged = (before, after, fixture) => {
  assert.ok(before?.tasks?.length, 'PB951 cannot accept empty task controls')
  const linked = before.tasks.filter((task) => String(task.milestoneId) === id(fixture.milestoneId))
  assert.ok(linked.length, 'PB951 needs a task directly linked to the completed milestone')
  for (const task of [...linked, before.task]) {
    assert.equal(id(task.projectId), id(fixture.projectId), 'PB951 foreign task control')
    assert.equal(task.status, 'PENDING_DISPATCH', 'PB951 task control must require human dispatch')
    assert.equal(task.receiveTime, null)
    assert.equal(task.completedTime, null)
  }
  assert.equal(before.sql.available, true, 'PB951 missing database control before completion')
  assert.equal(after?.sql?.available, true, 'PB951 missing database control after completion')
  assert.ok(before.sql.rows.length, 'PB951 empty database control')
  assert.deepEqual(after.tasks, before.tasks, 'PB951 milestone completion changed formal task facts')
  assert.deepEqual(after.task, before.task, 'PB951 milestone completion changed the protection task')
  assert.deepEqual(after.sql.rows, before.sql.rows, 'PB951 milestone completion changed task SQL facts')
}

export const assertMilestoneCompletion = (completed, expected) => {
  assert.equal(id(completed?.id), id(expected.id))
  assert.equal(id(completed.projectId), id(expected.projectId))
  assert.equal(completed.status, 'COMPLETED')
  assert.equal(completed.confirmed, true)
  assert.equal(completed.manualConclusion, expected.manualConclusion)
  assert.equal(completed.actualFinishDate, expected.today)
  assert.equal(completed.exitCondition, expected.exitCondition)
  assert.deepEqual(JSON.parse(completed.requiredDeliverablesJson), expected.deliverables)
  assert.equal(completed.healthStatus, expected.healthStatus)
  assert.equal(completed.warningStatus, expected.warningStatus)
}

export const assertMilestoneDatabaseCompletion = (snapshot, expected) => {
  assert.equal(snapshot?.available, true, 'PB951 requires actual database milestone evidence')
  assert.equal(snapshot.rows.length, 1, 'PB951 missing/ambiguous database milestone')
  const [row] = snapshot.rows
  assert.equal(row[0], id(expected.id))
  assert.equal(row[1], id(expected.projectId))
  assert.equal(row[2], 'COMPLETED')
  assert.ok(['1', '\u0001'].includes(row[3]), 'PB951 database milestone not confirmed')
  assert.equal(row[4], expected.today)
  assert.equal(row[5], expected.exitCondition)
  assert.deepEqual(JSON.parse(row[6]), expected.deliverables)
  assert.equal(row[7], expected.healthStatus)
  assert.equal(row[8], expected.warningStatus)
  assert.equal(row[9], expected.manualConclusion)
}

export const observeMilestoneBrowser = (page, timeoutMs = config.browserTimeoutMs) => {
  const requests = []
  const responses = []
  const errors = []
  const pending = new Set()
  const relevant = (url) => /^\/admin-api\/pm\/milestone\/(?:list|save|confirm|complete)$/.test(url.pathname)
  const requestEvent = (request) => {
    const url = new URL(request.url())
    let body
    if (request.postData()) {
      if (request.headers()[ENCRYPT_HEADER.toLowerCase()] === 'true') {
        const cipher = createDecipheriv('aes-256-ecb',
          Buffer.from(process.env.CFOR_API_ENCRYPT_REQUEST_KEY || REQ_KEY, 'utf8'), null)
        body = JSON.parse(Buffer.concat([
          cipher.update(request.postData(), 'base64'), cipher.final()
        ]).toString('utf8'))
      } else body = request.postDataJSON()
    }
    return { method: request.method(), pathname: url.pathname,
      query: Object.fromEntries(url.searchParams),
      ...(body !== undefined ? { body } : {}) }
  }
  const onRequest = (request) => {
    if (!relevant(new URL(request.url()))) return
    try { requests.push(requestEvent(request)) } catch (error) { errors.push(error) }
  }
  const onResponse = (response) => {
    if (!relevant(new URL(response.url()))) return
    const operation = (async () => {
      const event = requestEvent(response.request())
      event.data = await browserBusinessPayload(response)
      responses.push(event)
    })().catch((error) => errors.push(error)).finally(() => pending.delete(operation))
    pending.add(operation)
  }
  page.on('request', onRequest)
  page.on('response', onResponse)
  const healthy = () => { if (errors.length) throw errors[0] }
  return {
    requests, responses,
    mark: () => responses.length,
    async waitFor (predicate, after = 0) {
      const deadline = Date.now() + timeoutMs
      do {
        healthy()
        const event = responses.slice(after).find(predicate)
        if (event) return event
        await delay(20)
      } while (Date.now() < deadline)
      throw new Error('PB951 timed out awaiting the real milestone browser response')
    },
    async flush () {
      while (pending.size) await Promise.all([...pending])
      healthy()
    },
    async stop () {
      page.off('request', onRequest)
      page.off('response', onResponse)
      while (pending.size) await Promise.all([...pending])
    }
  }
}

export const prepareMilestoneClosure = async ({
  api, fixture, caseRecord, today = todayInShanghai(), readSql = runReadOnlySql
}) => {
  assertPmClosureLocalTarget()
  const project = data(await api.getBusiness(`/pm/project/get?id=${id(fixture.projectId)}`))
  assertMilestoneProjectOwnership(fixture, project)
  fixture.project = project
  addCheck(caseRecord, 'fixture', () => {
    assert.equal(project.plannedStartDate, offsetDate(today, -30))
    assert.equal(project.plannedEndDate, offsetDate(today, 180))
  }, `projectId=${fixture.projectId}; handoverId=${fixture.handoverId}; marker=${fixture.marker}`)
  const owner = data(await api.getBusiness('/system/user/profile/get'))
  assert.equal(id(owner?.id), id(fixture.ownerId))
  let workingDate
  for (let offset = 0; offset < 30; offset++) {
    const date = offsetDate(today, -7 + offset)
    const holiday = data(await api.getBusiness(`/hrm/attendance/holiday/check?day=${date}T00:00:00`))
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
    if (Number(holiday?.type) === 1 ||
        (Number(holiday?.type) !== 2 && weekday !== 0 && weekday !== 6)) {
      workingDate = date
      caseRecord.pb951WorkingDay = { date, holiday, fallbackWeekday: weekday }
      break
    }
  }
  assert.ok(workingDate, 'PB951 no actual HRM working date found')
  const list = async () => {
    const rows = data(await api.getBusiness(`/pm/milestone/list?projectId=${id(fixture.projectId)}`))
    assert.ok(Array.isArray(rows), 'PB951 missing formal milestone list')
    for (const row of rows) assert.equal(id(row.projectId), id(fixture.projectId))
    return rows
  }
  const existing = await list()
  assert.ok(existing.length >= 3, 'PB951 needs three template milestones on the new project')
  assert.equal(new Set(existing.map((row) => id(row.id))).size, existing.length)
  const owned = []
  for (const [index, template] of existing.slice(0, 3).entries()) {
    assert.equal(template.confirmed, false, 'PB951 refuses an already locked template milestone')
    assert.equal(template.status, 'NOT_STARTED')
    const body = {
      id: id(template.id), projectId: id(fixture.projectId), stageId: id(template.stageId),
      milestoneName: `${fixture.marker}_${['NO_EXIT', 'NO_DELIVERABLES', 'COMPLETE'][index]} 里程碑`,
      ownerId: fixture.ownerId, ownerName: owner.nickname,
      plannedStartDate: workingDate, plannedEndDate: workingDate, weightRate: template.weightRate,
      exitCondition: index === 0 ? null : `${fixture.marker} 客户签收且无未关闭缺陷`,
      requiredDeliverablesJson: index === 1 ? null : JSON.stringify([`${fixture.marker} 验收报告`]),
      healthStatus: 'NORMAL', warningStatus: 'NONE'
    }
    const saved = data(await api.postBusiness('/pm/milestone/save', body))
    assert.equal(id(saved), body.id, 'PB951 saved the wrong owned milestone')
    owned.push(body)
  }
  const target = owned[2]
  const taskId = id(data(await api.postBusiness('/pm/task/create-administrative', {
    projectId: fixture.projectId, taskName: `${fixture.marker} 责任人确认保护任务`,
    taskContent: fixture.marker, ownerId: fixture.ownerId, ownerName: owner.nickname,
    acceptanceOwnerId: fixture.ownerId, plannedStartDate: workingDate, plannedEndDate: workingDate,
    priority: 2, standardHours: 8, plannedHours: 8,
    requiredOutput: `${fixture.marker} 任务成果`, acceptanceCriteria: `${fixture.marker} 任务责任人单独验收`
  })))
  const tasksBefore = await readMilestoneTaskFacts(api, fixture, taskId, readSql)
  assertMilestoneTaskFactsUnchanged(tasksBefore, tasksBefore, {
    projectId: fixture.projectId, milestoneId: target.id
  })
  caseRecord.pb951TaskFacts = { before: tasksBefore }
  const readMilestone = async (milestoneId) => {
    const matches = (await list()).filter((row) => id(row.id) === id(milestoneId))
    assert.equal(matches.length, 1, 'PB951 missing/ambiguous owned milestone readback')
    return matches[0]
  }
  caseRecord.pb951GateEvidence = []
  for (const [index, missingField] of ['exitCondition', 'requiredDeliverablesJson'].entries()) {
    const negative = owned[index]
    await api.putBusiness(`/pm/milestone/confirm?id=${negative.id}`)
    const before = await readMilestone(negative.id)
    const manualConclusion = `${fixture.marker} 负例结论`
    assertPb951GatePrerequisites({
      fixture, project, milestone: before, milestoneId: negative.id,
      milestoneName: negative.milestoneName, workingDate, workingDay: true,
      manualConclusion, missingField
    })
    const response = await api.put(`/pm/milestone/complete?id=${negative.id}` +
      `&manualConclusion=${encodeURIComponent(manualConclusion)}`, undefined, {
      expectedBusinessRejection: {
        code: 1055004003, message: '里程碑日期超出项目计划窗口或结束日期早于开始日期'
      }
    })
    const after = await readMilestone(negative.id)
    addCheck(caseRecord, index === 0 ? 'noExit' : 'noDeliverables',
      () => assertPb951GateRejection(response, before, after),
      `missingField=${missingField}; milestoneId=${negative.id}; workingDate=${workingDate}`)
    caseRecord.pb951GateEvidence.push({
      missingField, before, response, after, workingDate, workingDay: true
    })
  }
  return { fixture, owned, target, taskId, tasksBefore, readMilestone, today }
}

export const runProjectMilestoneClosure = async ({
  api, page, record, caseRecord, outputDir, createProject
}) => {
  assertPmClosureLocalTarget()
  registerMilestoneClosureAssertions(caseRecord)
  await assertLocalWriteSafety(caseRecord)
  const today = todayInShanghai()
  const fixture = await createProject({
    plannedStartDate: offsetDate(today, -30), plannedEndDate: offsetDate(today, 180)
  })
  assertMilestoneProjectOwnership(fixture)
  caseRecord.pb951Fixture = {
    projectId: fixture.projectId, handoverId: fixture.handoverId,
    marker: fixture.marker, projectCode: fixture.project.projectCode
  }
  const closure = await prepareMilestoneClosure({ api, fixture, caseRecord, today })
  const { owned, target, taskId, tasksBefore, readMilestone } = closure
  caseRecord.pb951TaskFacts = { before: tasksBefore }
  const capture = observePage(page, record)
  const browser = observeMilestoneBrowser(page)
  const viewport = page.viewportSize()
  const errorsBefore = Object.fromEntries(
    ['consoleErrors', 'pageErrors', 'requestFailures', 'failedApiResponses']
      .map((key) => [key, record[key]?.length || 0])
  )
  const screenshot = async (name) => {
    await capture.flushResponses()
    await browser.flush()
    await saveScreenshot(page, outputDir, name, record)
  }
  const row = (milestone = target) =>
    page.locator('.el-table__body tr').filter({ hasText: milestone.milestoneName })
  const dialog = page.locator('.el-dialog:visible')
  const field = (label) => dialog.locator('.el-form-item').filter({
    has: page.locator('.el-form-item__label', { hasText: label })
  }).locator('textarea, input').first()
  const reload = async () => {
    await capture.flushResponses()
    const mark = browser.mark()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await browser.waitFor((event) => event.method === 'GET' &&
      event.pathname.endsWith('/milestone/list') && event.query.projectId === fixture.projectId, mark)
    await row().waitFor({ state: 'visible' })
  }
  try {
    // The portal starts real business prefetches after login; drain them before navigation.
    await capture.flushResponses({ timeoutMs: 60000 })
    await openRoute(page,
      `/project/execution/milestone-confirm/list?projectCode=${fixture.project.projectCode}`,
      { readySelector: '.pm-implementation-page' })
    const mark = browser.mark()
    await page.getByRole('button', { name: '准出验收', exact: true }).click()
    await page.waitForURL(`**/project/milestones?projectCode=${fixture.project.projectCode}`)
    const listEvent = await browser.waitFor((event) => event.method === 'GET' &&
      event.pathname.endsWith('/milestone/list') && event.query.projectId === fixture.projectId, mark)
    await row().waitFor({ state: 'visible' })
    addCheck(caseRecord, 'entry', () => {
      assert.equal(new URL(page.url()).pathname, '/project/milestones')
      assert.equal(new URL(page.url()).searchParams.get('projectCode'), fixture.project.projectCode)
      assert.ok(listEvent.data.some((item) => id(item.id) === target.id))
    }, `route=${page.url()}; projectId=${fixture.projectId}`)
    await screenshot('pb951-01-official-page')
    for (const [index, negative] of owned.slice(0, 2).entries()) {
      const disabled = await row(negative).getByRole('button', { name: '人工完成', exact: true }).isDisabled()
      const edits = await row(negative).getByRole('button', { name: '编辑', exact: true }).count()
      addCheck(caseRecord, index === 0 ? 'noExitUi' : 'noDeliverablesUi', () => {
        assert.equal(disabled, true)
        assert.equal(edits, 0)
      }, `milestoneId=${negative.id}`)
    }
    await row().getByRole('button', { name: '编辑', exact: true }).click()
    await dialog.waitFor({ state: 'visible' })
    const exitCondition = `${fixture.marker} 客户签收完成，测试记录通过`
    const deliverables = [`${fixture.marker} 签署验收报告`, `${fixture.marker} 交付物清单`]
    await field('准出条件').fill(exitCondition)
    await field('必需交付物').fill(deliverables.join('\n'))
    const saveMark = browser.mark()
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    const saved = await browser.waitFor((event) =>
      event.method === 'POST' && event.pathname.endsWith('/milestone/save'), saveMark)
    await dialog.waitFor({ state: 'hidden' })
    const stored = await readMilestone(target.id)
    addCheck(caseRecord, 'save', () => {
      assert.equal(id(saved.body?.id), target.id)
      assert.equal(id(saved.body.projectId), id(fixture.projectId))
      for (const value of [saved.body, stored]) {
        assert.equal(value.exitCondition, exitCondition)
        assert.deepEqual(JSON.parse(value.requiredDeliverablesJson), deliverables)
      }
      assert.equal(stored.healthStatus, 'NORMAL')
      assert.equal(stored.warningStatus, 'NONE')
      assert.equal(stored.manualConclusion, null)
    }, `milestoneId=${target.id}; deliverables=${JSON.stringify(deliverables)}`)
    await reload()
    await row().getByRole('button', { name: '编辑', exact: true }).click()
    const refreshedExit = await field('准出条件').inputValue()
    const refreshedDeliverables = await field('必需交付物').inputValue()
    addCheck(caseRecord, 'refresh', () => {
      assert.equal(refreshedExit, exitCondition)
      assert.equal(refreshedDeliverables, deliverables.join('\n'))
    })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const confirmMark = browser.mark()
    await row().getByRole('button', { name: '确认', exact: true }).click()
    await page.locator('.el-message-box').getByRole('button', { name: '确定', exact: true }).click()
    await browser.waitFor((event) => event.method === 'PUT' &&
      event.pathname.endsWith('/milestone/confirm') && event.query.id === target.id, confirmMark)
    const confirmed = await readMilestone(target.id)
    addCheck(caseRecord, 'confirm', () => {
      assert.equal(confirmed.confirmed, true)
      assert.equal(browser.requests.filter((event) => event.method === 'PUT' &&
        event.pathname.endsWith('/milestone/confirm') && event.query.id === target.id).length, 1)
    })
    await row().getByRole('button', { name: '人工完成', exact: true }).click()
    const prompt = page.locator('.el-message-box')
    await prompt.waitFor({ state: 'visible' })
    const completeCount = () => browser.requests.filter((event) =>
      event.pathname.endsWith('/milestone/complete')).length
    const beforeBlank = completeCount()
    await prompt.getByRole('button', { name: '确定', exact: true }).click()
    await prompt.locator('.el-message-box__errormsg').filter({ hasText: '请填写内容' }).waitFor()
    addCheck(caseRecord, 'blank', () => assert.equal(completeCount(), beforeBlank))
    await screenshot('pb951-03-blank-conclusion-blocked')
    const manualConclusion = `${fixture.marker} 已逐项核对签署验收报告和交付物清单，准予完成。`
    await prompt.locator('textarea').fill(manualConclusion)
    const completeMark = browser.mark()
    await prompt.getByRole('button', { name: '确定', exact: true }).click()
    const completedRequest = await browser.waitFor((event) => event.method === 'PUT' &&
      event.pathname.endsWith('/milestone/complete') && event.query.id === target.id, completeMark)
    await prompt.waitFor({ state: 'hidden' })
    const completed = await readMilestone(target.id)
    const expected = {
      id: target.id, projectId: fixture.projectId, today, exitCondition, deliverables,
      manualConclusion, healthStatus: stored.healthStatus, warningStatus: stored.warningStatus
    }
    addCheck(caseRecord, 'complete', () => {
      assert.equal(completedRequest.query.manualConclusion, manualConclusion)
      assertMilestoneCompletion(completed, expected)
    }, `milestoneId=${target.id}; actualFinishDate=${today}; conclusion=${manualConclusion}`)
    caseRecord.pb951CompletedMilestone = completed
    await reload()
    const rowText = await row().innerText()
    const completeActions = await row().getByRole('button', { name: '人工完成', exact: true }).count()
    const editActions = await row().getByRole('button', { name: '编辑', exact: true }).count()
    addCheck(caseRecord, 'list', () => {
      assert.ok(rowText.includes(manualConclusion))
      assert.ok(rowText.includes(today))
      assert.equal(completeActions, 0)
      assert.equal(editActions, 0)
    })
    await row().getByRole('button', { name: '查看', exact: true }).click()
    await dialog.waitFor({ state: 'visible' })
    const detail = await dialog.innerText()
    addCheck(caseRecord, 'detail', () => {
      for (const text of ['准出条件', '必需交付物', '系统健康状态', '系统预警状态',
        '人工结论', '实际完成日期', exitCondition, ...deliverables, manualConclusion, today, '正常', '无']) {
        assert.ok(detail.includes(text), `PB951 missing detail ${text}`)
      }
    })
    await screenshot('pb951-04-completed-detail-desktop')
    caseRecord.pb951Layout = []
    for (const size of [{ width: 1100, height: 800 }, { width: 390, height: 844 }]) {
      await capture.flushResponses()
      await page.setViewportSize(size)
      // Responsive layout changes can destroy the previous dialog; use the current row.
      await page.waitForTimeout(600)
      await row().waitFor({ state: 'visible' })
      await capture.flushResponses()
      if (!await dialog.isVisible()) await row().getByRole('button', { name: '查看', exact: true }).click()
      await dialog.waitFor({ state: 'visible' })
      const layout = await dialog.evaluate((element) => {
        const box = element.getBoundingClientRect()
        return { left: box.left, right: box.right, viewport: innerWidth,
          content: [...element.querySelectorAll('.el-descriptions__content')].map((item) =>
            ({ width: item.clientWidth, scrollWidth: item.scrollWidth })) }
      })
      assert.ok(layout.content.length, 'PB951 missing rendered detail cells')
      assert.ok(layout.left >= -1 && layout.right <= layout.viewport + 1)
      assert.ok(layout.content.every((item) => item.scrollWidth <= item.width + 1))
      caseRecord.pb951Layout.push({ size, ...layout })
      await screenshot(`pb951-completed-detail-${size.width}`)
    }
    addCheck(caseRecord, 'layout', () => assert.equal(caseRecord.pb951Layout.length, 2))
    const tasksAfter = await readMilestoneTaskFacts(api, fixture, taskId)
    caseRecord.pb951TaskFacts.after = tasksAfter
    addCheck(caseRecord, 'tasks', () => assertMilestoneTaskFactsUnchanged(tasksBefore, tasksAfter, {
      projectId: fixture.projectId, milestoneId: target.id
    }), `projectId=${fixture.projectId}; comparedTasks=${tasksBefore.tasks.length}; linkedMilestone=${target.id}`)
    caseRecord.pb951DatabaseMilestone = await runReadOnlySql(`SELECT id,project_id,status,confirmed,
      actual_finish_date,exit_condition,required_deliverables_json,health_status,warning_status,
      manual_conclusion FROM pm_project_milestone WHERE id=${id(target.id)}
      AND project_id=${id(fixture.projectId)} AND tenant_id=1 AND deleted=0`)
    addCheck(caseRecord, 'database',
      () => assertMilestoneDatabaseCompletion(caseRecord.pb951DatabaseMilestone, expected))
    await capture.flushResponses()
    await browser.flush()
    addCheck(caseRecord, 'browser', () => {
      for (const [key, start] of Object.entries(errorsBefore)) {
        assert.deepEqual((record[key] || []).slice(start), [], `PB951 ${key}`)
      }
      assert.equal(browser.requests.filter((event) => event.method === 'PUT' &&
        event.pathname.endsWith('/milestone/complete') && event.query.id === target.id).length, 1,
      'PB951 must issue exactly one positive completion request')
    })
    caseRecord.evidence.push(`PB951 正式页面保存/确认/人工完成 project=${fixture.projectId}, ` +
      `milestone=${target.id}; 原断言0-3及旧页面remaining门禁逐项登记；完整任务API/SQL前后比对`)
    caseRecord.notes.push('PB951 本轮专属正式 PM 项目、里程碑及任务保留供验收；未改共享配置或后端，未代收或自动完成任务。')
    finalizeMilestoneClosureEvidence(caseRecord)
    return { acceptanceComplete: caseRecord.catalogComplete }
  } finally {
    caseRecord.pb951BrowserRequests = [...browser.requests]
    caseRecord.pb951BrowserResponses = [...browser.responses]
    await browser.stop()
    if (viewport && !page.isClosed()) await page.setViewportSize(viewport)
  }
}
