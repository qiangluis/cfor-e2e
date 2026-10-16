import { matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { config } from '../config/index.mjs'
import { assertLocalDatabase } from '../lib/db.mjs'
import { isCostOpeningFixtureMonth } from './cost-model.mjs'

export const COST_OPENING_CHECKS = Object.freeze({
  draft: 'COST-002 专属期初在制草稿保存并按正式期间精确回读',
  material: 'COST-002 期初在制引用启用 Base 存货精确 ID 与编码',
  amounts: 'COST-002 期初在制总额等于材料人工费用之和且错误总额拒绝',
  unit: 'COST-002 期初在制单位成本等于总额除数量且错误单位成本拒绝',
  states: 'COST-002 正式确认锁定禁止覆盖及有原因回退状态机逐步回读',
  cleanup: 'COST-002 专属期初在制清理回退完成，历史审计保留'
})

const requireFact = (condition, label) => {
  if (!condition) throw new Error(`COST-002: ${label}`)
}
const check = (record, name, passed, details) => {
  record.checks.push({ name, passed: Boolean(passed), details })
  requireFact(passed, name)
}
const signature = (rows) => JSON.stringify(rows)

const exactId = (value, label) => {
  const text = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : ''
  requireFact(/^[1-9]\d*$/.test(text), `${label}不是精确字符串 ID`)
  return text
}

const normalizeFixture = (fixture) => {
  if (!fixture) return fixture
  return {
    ...fixture,
    modelId: fixture.modelId || fixture.modelVersionId,
    month: fixture.month || fixture.effectiveMonth
  }
}

async function assertFormalContext (api, fixture) {
  const model = (await api.getBusiness(`/cost/model-versions/${fixture.modelId}`)).data
  requireFact(model && exactId(model.id, '模型') === fixture.modelId &&
    String(model.accountingOrgId) === '1' &&
    model.versionNo === fixture.versionNo &&
    model.enterpriseType === 'MANUFACTURING' &&
    model.effectiveMonth === fixture.month &&
    model.status === 'LOCKED' &&
    model.remark === fixture.remark,
  '正式模型缺失、未锁定、月份错误或不属于本轮')

  const period = (await api.getBusiness(`/cost/periods/${fixture.periodId}`)).data
  requireFact(period && exactId(period.id, '期间') === fixture.periodId &&
    String(period.accountingOrgId) === '1' &&
    period.period === fixture.month &&
    exactId(period.modelVersionId, '期间模型') === fixture.modelId &&
    period.modelVersionNo === fixture.versionNo &&
    period.enterpriseType === 'MANUFACTURING' &&
    period.status === 'ACCOUNTING' &&
    period.currentPublicationId == null,
  '正式期间缺失、模型绑定错误、不是 2099-12 或不是核算中')
  return { model, period }
}

export async function runCostOpeningClosure ({
  api, caseRecord, record, onDraft, dependencies = {}
}) {
  const runtimeConfig = dependencies.config || config
  const fixture = normalizeFixture(caseRecord.fixtures?.costOpening || caseRecord.fixtures?.costScenario)
  requireFact(runtimeConfig.target === 'local' &&
    String(runtimeConfig.tenantId) === '1' &&
    record?.environment?.target === 'local' &&
    String(record?.environment?.tenantId) === '1' &&
    (dependencies.writeFixtures ?? process.env.CFOR_E2E_WRITE_FIXTURES === 'true') === true,
  '写侧仅允许 local tenant 1 且必须显式启用 CFOR_E2E_WRITE_FIXTURES=true')
  await (dependencies.assertLocalDatabase || assertLocalDatabase)()
  requireFact(fixture?.tenantId === '1' && fixture.runId === record.runId &&
    fixture.scenario === 'accounting' && fixture.period?.status === 'ACCOUNTING',
  '缺少本轮核算中专属期间')
  requireFact(onDraft == null || typeof onDraft === 'function', '草稿观察器不是函数')
  requireFact(fixture.caseId === 'COST-002' &&
    isCostOpeningFixtureMonth(fixture.month) &&
    fixture.effectiveMonth === fixture.month &&
    fixture.versionNo === `E2E-SC-ACCOUNTING-${fixture.suffix}` &&
    fixture.remark === `CFOR-E2E:costScenario:accounting:${record.runId}:` +
      `${fixture.suffix}:tenant=1:org=1:month=${fixture.month}`,
  'COST-002 夹具不是本轮 2099-12 专属夹具')
  requireFact(typeof fixture.modelId === 'string' && /^[1-9]\d*$/.test(fixture.modelId),
    '缺少专属成本模型精确 ID')
  requireFact(typeof fixture.periodId === 'string' && /^[1-9]\d*$/.test(fixture.periodId),
    '缺少专属成本期间精确 ID')
  requireFact(typeof fixture.costCenterId === 'string' && /^[1-9]\d*$/.test(fixture.costCenterId),
    '缺少专属成本中心精确 ID')
  await assertFormalContext(api, fixture)
  const center = (await api.getBusiness(`/cost/centers/${fixture.costCenterId}`)).data
  requireFact(center?.id === fixture.costCenterId &&
    String(center.accountingOrgId) === '1' && center.status === 'ENABLED' &&
    center.code === `E2E-SC-${fixture.suffix}` &&
    center.name === `E2E成本场景中心${fixture.suffix}` && center.remark === fixture.remark,
  '成本中心不是本轮专属中心，拒绝选择共享首行')
  const candidates = (await api.getBusiness(
    '/mes/basMaterial/list/dictText?pageNo=1&pageSize=100&isEnabled=1'
  )).data
  const material = (candidates?.records || candidates?.list || [])
    .find((row) => row.id && row.code && Number(row.isEnabled) === 1)
  requireFact(material, '缺少启用 Base 存货，未修改共享存货')
  const exactMaterial = (await api.getBusiness(`/mes/basMaterial/queryById?id=${material.id}`)).data
  requireFact(String(exactMaterial?.id) === String(material.id) &&
    exactMaterial.code === material.code && Number(exactMaterial.isEnabled) === 1,
  'Base 存货详情不匹配')
  const path = `/cost/periods/${fixture.periodId}/opening-wip?stage=OPENING`
  const action = (name, params = '') =>
    `/cost/periods/${fixture.periodId}/opening-wip/${name}?stage=OPENING${params}`
  const payload = [{
    stage: 'OPENING', objectKey: `E2E-COST002-${fixture.suffix}`,
    materialId: String(material.id), productCode: material.code,
    costCenterCode: center.code, costCenterName: center.name,
    quantity: 2, materialAmount: 100, laborAmount: 20, expenseAmount: 10,
    totalAmount: 130, unitCost: 65, sourceType: 'MANUAL', remark: fixture.remark
  }]
  const read = async () => (await api.getBusiness(path)).data
  const assertRow = (rows, status) => {
    requireFact(Array.isArray(rows) && rows.length === 1, '专属在制不是唯一行')
    const row = rows[0]
    requireFact(String(row.periodId) === fixture.periodId &&
      row.objectKey === payload[0].objectKey && row.remark === fixture.remark &&
      row.costCenterCode === center.code && row.costCenterName === center.name &&
      row.status === status && row.stage === 'OPENING', '在制行所有权或状态漂移')
    return row
  }
  const before = await read()
  requireFact(Array.isArray(before) && before.length === 0, '专属期初已有记录，拒绝覆盖')
  let saved = false
  let reversed = false
  let operationError
  let cleanupError
  try {
    const draft = (await api.putBusiness(path, payload)).data
    saved = true
    const stored = await read()
    assertRow(stored, 'DRAFT')
    check(caseRecord, COST_OPENING_CHECKS.draft, signature(draft) === signature(stored),
      `period=${fixture.periodId}; id=${stored[0].id}`)
    check(caseRecord, COST_OPENING_CHECKS.material,
      stored[0].materialId === String(material.id) && stored[0].productCode === material.code,
      `material=${material.id}; code=${material.code}`)
    for (const [field, value, message, name] of [
      ['totalAmount', 131, 'Total amount must equal material, labor and expense amounts', COST_OPENING_CHECKS.amounts],
      ['unitCost', 66, 'Unit cost must equal total amount divided by quantity', COST_OPENING_CHECKS.unit]
    ]) {
      const rejected = await api.put(path, [{ ...payload[0], [field]: value }], {
        expectedBusinessRejection: { code: 422001, message: new RegExp(message) }
      })
      const unchanged = signature(stored) === signature(await read())
      check(caseRecord, name,
        matchesExpectedBusinessRejection(rejected, { code: 422001, message: new RegExp(message) }) &&
          unchanged && (field === 'totalAmount'
            ? Number(stored[0].totalAmount) === Number(stored[0].materialAmount) +
              Number(stored[0].laborAmount) + Number(stored[0].expenseAmount)
            : Number(stored[0].unitCost) === Number(stored[0].totalAmount) / Number(stored[0].quantity)),
      `code=${rejected.code}; formalUnchanged=${unchanged}`)
    }
    if (onDraft) await onDraft({ fixture, openingRow: structuredClone(stored[0]) })
    await api.postBusiness(action('confirm'))
    const confirmed = assertRow(await read(), 'CONFIRMED')
    requireFact(confirmed.confirmedBy != null && confirmed.confirmedAt != null,
      '确认缺少真实操作人与时间')
    await api.postBusiness(action('lock'))
    const lockedRows = await read()
    const locked = assertRow(lockedRows, 'LOCKED')
    requireFact(locked.lockedBy != null && locked.lockedAt != null, '锁定缺少操作人与时间')
    const blocked = await api.put(path, payload, { expectedBusinessRejection: {
      code: 422001, message: 'Confirmed or locked opening WIP cannot be overwritten'
    } })
    requireFact(matchesExpectedBusinessRejection(blocked, {
      code: 422001, message: 'Confirmed or locked opening WIP cannot be overwritten'
    }) && signature(await read()) === signature(lockedRows), '锁定覆盖未拒绝或正式行改变')
    await api.postBusiness(action('reverse', `&reason=${encodeURIComponent(fixture.remark)}`))
    const reversedRows = await read()
    const row = assertRow(reversedRows, 'REVERSED')
    reversed = true
    check(caseRecord, COST_OPENING_CHECKS.states,
      row.reversedBy != null && row.reversedAt != null && row.reverseReason === fixture.remark,
      `DRAFT->CONFIRMED->LOCKED->REVERSED; period=${fixture.periodId}; version=${row.version}`)
  } catch (error) {
    operationError = error
  } finally {
    if (saved && !reversed) {
      try {
        const current = await read()
        requireFact(current.length === 1 && current[0].remark === fixture.remark,
          '清理拒绝在制所有权漂移')
        await api.postBusiness(action('reverse', `&reason=${encodeURIComponent(fixture.remark)}`))
        assertRow(await read(), 'REVERSED')
        reversed = true
      } catch (error) {
        cleanupError = error
      }
    }
    if (saved) caseRecord.checks.push({
      name: COST_OPENING_CHECKS.cleanup, passed: reversed,
      details: `period=${fixture.periodId}; reversed=${reversed}; physicalDelete=false`
    })
  }
  if (operationError || cleanupError) throw new AggregateError(
    [operationError, cleanupError].filter(Boolean),
    [operationError?.message, cleanupError?.message].filter(Boolean).join('; ')
  )
  return { fixture, openingRow: assertRow(await read(), 'REVERSED') }
}
