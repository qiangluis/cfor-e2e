import assert from 'node:assert/strict'
import { runReadOnlySql } from '../lib/db.mjs'

const ownedId = (value) => {
  assert.match(String(value ?? ''), /^[1-9]\d*$/, 'Missing inspection resource ID')
  assert.ok(typeof value !== 'number' || Number.isSafeInteger(value), 'Lossy inspection resource ID')
  return String(value)
}

export const readOtherInspectionFacts = async (assetId, readSql = runReadOnlySql) => {
  const excludedId = ownedId(assetId)
  const snapshot = await readSql(`
    SELECT id, asset_id, customer_id, quarter_code, source_type, status, config_plan_id,
      config_plan_version, config_snapshot, required_finish_time, appointment_time,
      engineer_id, report_no, report_snapshot, version, update_time, deleted
    FROM after_sales_inspection_task
    WHERE tenant_id=1 AND asset_id<>'${excludedId}' ORDER BY id
  `)
  if (!snapshot.available) throw new Error(`BLOCKED: PB122 read evidence unavailable: ${snapshot.reason}`)
  assert.ok(Array.isArray(snapshot.rows), 'Missing other inspection facts')
  return snapshot
}

export const assertInspectionTaskSnapshot = (task, { assetFixture, plan, item, refs, standard }) => {
  assert.equal(task?.sourceType, 'QUARTER_AUTO')
  assert.equal(String(task.assetId), ownedId(assetFixture.assetId))
  assert.equal(String(task.customerId), ownedId(assetFixture.customerId))
  assert.equal(String(task.contactId), ownedId(assetFixture.contactId))
  assert.equal(String(task.configPlanId), ownedId(plan.id))
  assert.equal(task.configPlanVersion, plan.publishedVersion)
  assert.equal(task.assetName, assetFixture.detail.asset.assetName)
  const snapshot = JSON.parse(task.configSnapshot)
  assert.equal(String(snapshot.planId), String(plan.id))
  assert.equal(snapshot.planCode, plan.planCode)
  assert.equal(snapshot.planVersion, plan.publishedVersion)
  for (const field of ['appointmentRequired', 'customerConfirmRequired', 'signatureRequired']) {
    assert.equal(snapshot[field], true, `${field} was not frozen`)
  }
  for (const [field, expected] of Object.entries(refs)) assert.equal(snapshot[field], expected)
  assert.equal(snapshot.items.length, 1)
  const capturedItem = snapshot.items[0]
  assert.equal(String(capturedItem.itemId), ownedId(item.id))
  assert.equal(capturedItem.itemCode, item.itemCode)
  assert.equal(capturedItem.itemName, item.itemName)
  assert.equal(capturedItem.resultType, item.resultType)
  assert.equal(capturedItem.execRequirement, item.execRequirement)
  assert.equal(capturedItem.standardHours, item.standardHours)
  assert.equal(capturedItem.attachmentRequired, item.attachmentRequired)
  assert.equal(capturedItem.standard, standard)
  assert.deepEqual(snapshot.cycles, [{
    cycleType: 'TIME', cycleValue: 30, cycleUnit: 'DAY', dataSource: 'CALENDAR'
  }])
  const asset = snapshot.assetSnapshot
  for (const [field, expected] of Object.entries({
    assetId: assetFixture.assetId, customerId: assetFixture.customerId,
    materialId: assetFixture.materialId, contactId: assetFixture.contactId
  })) assert.equal(String(asset?.[field]), ownedId(expected), `Missing asset snapshot ${field}`)
  for (const field of ['assetNo', 'assetName', 'serviceStatus', 'serviceStartDate', 'serviceEndDate']) {
    assert.equal(asset?.[field], assetFixture.detail.asset[field], `Missing asset snapshot ${field}`)
  }
  return snapshot
}

export const assertInspectionSnapshotUnchanged = (before, after) => {
  assert.ok(before && after, 'Both task snapshots must be read back')
  for (const field of [
    'id', 'assetId', 'customerId', 'contactId', 'assetName', 'customerName', 'quarterCode',
    'sourceType', 'status', 'requiredFinishTime', 'configPlanId', 'configPlanVersion',
    'configSnapshot', 'version'
  ]) assert.deepEqual(after[field], before[field], `Historical task changed ${field}`)
}

export const queryInspectionTaskInBrowser = async (page, taskNo) => {
  assert.ok(typeof taskNo === 'string' && taskNo.length > 0, 'Missing inspection task number')
  await page.getByPlaceholder('任务编号/客户/资产名称').fill(taskNo)
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => {
      const url = new URL(candidate.url())
      return candidate.request().method() === 'GET' &&
        url.pathname.endsWith('/after-sales/inspection/page') &&
        url.searchParams.get('keyword') === taskNo &&
        url.searchParams.get('pageSize') === '10'
    }, { timeout: 30000 }),
    page.getByRole('button', { name: '查询', exact: true }).click()
  ])
  assert.equal(response.status(), 200, 'Inspection page query HTTP error')
  assert.equal(await response.finished(), null, 'Inspection page query transport error')
  await page.locator('.inspection-task-table .el-loading-mask:visible')
    .waitFor({ state: 'hidden', timeout: 30000 })
}
