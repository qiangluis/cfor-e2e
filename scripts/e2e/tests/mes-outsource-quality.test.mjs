import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildQualifiedInspectionPayload,
  businessDateAsiaShanghai,
  createDedicatedOutsourceQuality,
  isStableQualityId,
  OUTSOURCE_QUALITY_RETAINED,
  OUTSOURCE_QUALITY_SOURCE
} from '../fixtures/mes-outsource-quality.mjs'

const ok = (data) => ({ code: 0, data })

const makeQualityApi = (marker, { failRule = false, unsafeItemId = false } = {}) => {
  const calls = []
  let published = false
  let planRemark = ''
  let planName = ''
  const itemId = unsafeItemId ? Number.MAX_SAFE_INTEGER + 1 : '201'
  const planId = '202'
  const ruleId = '203'
  const api = {
    calls,
    async postBusiness(path, body) {
      calls.push({ method: 'POST', path, body })
      if (failRule && path === '/mes/quality/qualityMaterial/add') {
        throw new Error('simulated quality rule failure')
      }
      return ok(true)
    },
    async getBusiness(path) {
      calls.push({ method: 'GET', path })
      if (path.includes('/mes/quality/item/list/dictText')) {
        const itemCode = new URL(`http://quality${path}`).searchParams.get('itemCode')
        return ok([{
          id: itemId,
          itemCode,
          publishStatus: 1,
          itemType: '生产入库检验项目',
          inspectionResultType: 'select',
          inspectionResult: '1',
          judgmentMode: 'ENUM'
        }])
      }
      if (path.includes('/mes/quality/qualityPlan/list/dictText')) {
        const query = new URL(`http://quality${path}`).searchParams
        return ok([{
          id: planId,
          planName,
          remark: query.get('type') === '104' ? planRemark : 'wrong-type',
          type: 104,
          planCode: `${marker}-PLAN-CODE`,
          versionNo: 1,
          publishStatus: published ? 1 : 0
        }])
      }
      if (path.includes('/mes/quality/qualityMaterial/list/dictText')) {
        const query = new URL(`http://quality${path}`).searchParams
        return ok([{
          id: ruleId,
          materialId: query.get('materialId'),
          planId,
          type: query.get('types'),
          effectiveFrom: businessDateAsiaShanghai(),
          effectiveTo: null,
          applyOrgId: '',
          businessSubType: '',
          isDefault: true,
          priority: 0
        }])
      }
      throw new Error(`unexpected GET ${path}`)
    }
  }
  const originalPostBusiness = api.postBusiness.bind(api)
  api.postBusiness = async (path, body) => {
    if (path === '/mes/quality/qualityPlan/add') {
      planRemark = body.remark
      planName = body.planName
    }
    const response = await originalPostBusiness(path, body)
    if (path === '/mes/quality/qualityPlan/publish?id=202') published = true
    return response
  }
  return api
}

test('专属委外104前置使用生产入库项目、104已发布方案和专属FG规则', async () => {
  const marker = 'E2E-OUTSRC-QUALITY-UNIT'
  const caseRecord = { checks: [], notes: [], fixtures: [] }
  const api = makeQualityApi(marker)
  const fixture = { marker, draft: { prerequisite: { product: { id: '301' } } } }

  const result = await createDedicatedOutsourceQuality(api, caseRecord, fixture)

  assert.equal(result.materialId, '301')
  assert.equal(result.plan.type, 104)
  assert.equal(result.plan.row.publishStatus, 1)
  assert.equal(result.rule.row.materialId, '301')
  assert.equal(result.rule.row.planId, result.plan.planId)
  assert.equal(result.rule.row.type, '104')
  assert.equal(result.rule.row.isDefault, true)
  assert.equal(result.resources.length, 3)
  assert.deepEqual(caseRecord.fixtures.map((row) => row.kind), [
    'quality-item', 'quality-plan', 'quality-material-rule'
  ])
  assert.ok(caseRecord.fixtures.every((row) =>
    row.source === OUTSOURCE_QUALITY_SOURCE && row.cleanup === OUTSOURCE_QUALITY_RETAINED))

  const planAdd = api.calls.find((call) => call.path === '/mes/quality/qualityPlan/add')
  const ruleAdd = api.calls.find((call) => call.path === '/mes/quality/qualityMaterial/add')
  assert.equal(planAdd.body.type, 104)
  assert.equal(planAdd.body.qualityPlanSubList[0].itemId, result.item.itemId)
  assert.equal(ruleAdd.body.materialId, '301')
  assert.equal(ruleAdd.body.planId, result.plan.planId)
  assert.equal(ruleAdd.body.type, '104')
  assert.equal(ruleAdd.body.effectiveFrom, businessDateAsiaShanghai())
})

test('104方案回读不允许默认按101查询', async () => {
  const marker = 'E2E-OUTSRC-QUALITY-TYPE'
  const api = makeQualityApi(marker)
  const result = await createDedicatedOutsourceQuality(api, { checks: [], notes: [], fixtures: [] }, {
    marker,
    product: { id: '401' }
  })
  const planList = api.calls.find((call) => call.path.includes('/mes/quality/qualityPlan/list/dictText'))
  assert.match(planList.path, /[?&]type=104(?:&|$)/)
  assert.equal(result.plan.type, 104)
})

test('专属质检配置中途失败会保留已创建的项目和方案审计记录', async () => {
  const marker = 'E2E-OUTSRC-QUALITY-FAIL'
  const caseRecord = { checks: [], notes: [], fixtures: [] }
  await assert.rejects(() => createDedicatedOutsourceQuality(
    makeQualityApi(marker, { failRule: true }),
    caseRecord,
    { marker, product: { id: '501' } }
  ), /simulated quality rule failure/)
  assert.deepEqual(caseRecord.fixtures.map((row) => row.kind), ['quality-item', 'quality-plan'])
  assert.ok(caseRecord.fixtures.every((row) => row.cleanup === OUTSOURCE_QUALITY_RETAINED))
})

test('不安全数字ID在专属104前置入口被拒绝', async () => {
  assert.equal(isStableQualityId(Number.MAX_SAFE_INTEGER), true)
  assert.equal(isStableQualityId(Number.MAX_SAFE_INTEGER + 1), false)
  await assert.rejects(() => createDedicatedOutsourceQuality(
    makeQualityApi('E2E-OUTSRC-QUALITY-UNSAFE', { unsafeItemId: true }),
    { checks: [], notes: [], fixtures: [] },
    { marker: 'E2E-OUTSRC-QUALITY-UNSAFE', product: { id: '601' } }
  ), /质检项目未返回合法且安全的数字ID/)
})

test('合格104草稿payload保留MesStkIo:110、plan和srcEntryId并固定整批数量', () => {
  const detail = {
    id: '701',
    type: '104',
    srcBillType: 'MesStkIo:110',
    srcBillId: '702',
    inspectionPlan: '703',
    qty: 9,
    inspectionQty: 9,
    passQty: 0,
    concessionQty: 2,
    pendingJudgeQty: 7
  }
  const entries = [{
    id: '704',
    srcEntryId: '705',
    materialId: '706',
    qty: 9,
    inspectionQty: 9,
    passQty: 0,
    concessionQty: 2,
    pendingJudgeQty: 7
  }]
  const items = [{
    id: '707',
    itemId: '708',
    itemName: '专属项目',
    inspectionResult: '0',
    finalInspectionResult: '0',
    inspectionQty: 9,
    passQty: 0,
    ngQty: 9
  }]
  const payload = buildQualifiedInspectionPayload(detail, entries, items)

  assert.equal(payload.id, '701')
  assert.equal(payload.type, '104')
  assert.equal(payload.srcBillType, 'MesStkIo:110')
  assert.equal(payload.srcBillId, '702')
  assert.equal(payload.inspectionPlan, '703')
  assert.equal(payload.qty, 1)
  assert.equal(payload.inspectionQty, 1)
  assert.equal(payload.passQty, 1)
  assert.equal(payload.concessionQty, 0)
  assert.equal(payload.pendingJudgeQty, 0)
  assert.equal(payload.qualityInspectionEntryList[0].srcEntryId, '705')
  assert.equal(payload.qualityInspectionEntryList[0].qty, 1)
  assert.equal(payload.qualityInspectionEntryList[0].passQty, 1)
  assert.equal(payload.qualityInspectionItemList[0].itemId, '708')
  assert.equal(payload.qualityInspectionItemList[0].inspectionResult, '1')
  assert.equal(payload.qualityInspectionItemList[0].finalInspectionResult, '1')
})

test('合格104草稿payload拒绝错误类型、来源、缺失关联和多明细', () => {
  const detail = { id: '801', type: '104', srcBillType: 'MesStkIo:110', srcBillId: '802', inspectionPlan: '803' }
  const entry = { id: '804', srcEntryId: '805', materialId: '806' }
  const item = { id: '807', itemId: '808' }
  assert.throws(() => buildQualifiedInspectionPayload({ ...detail, type: '101' }, [entry], [item]), /不是104/)
  assert.throws(() => buildQualifiedInspectionPayload({ ...detail, srcBillType: 'MesStkIo:104' }, [entry], [item]), /来源不是 MesStkIo:110/)
  assert.throws(() => buildQualifiedInspectionPayload({ ...detail, inspectionPlan: null }, [entry], [item]), /质检方案未返回合法/)
  assert.throws(() => buildQualifiedInspectionPayload(detail, [{ ...entry, srcEntryId: null }], [item]), /来源库存明细未返回合法/)
  assert.throws(() => buildQualifiedInspectionPayload(detail, [entry, { ...entry, id: '809' }], [item]), /只能有一条/)
  assert.throws(() => buildQualifiedInspectionPayload(detail, [entry], []), /缺少质检项目明细/)
})
