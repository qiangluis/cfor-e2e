import { randomUUID } from 'node:crypto'
import { config } from '../config/index.mjs'
import { assertLocalWriteSafety } from '../lib/db.mjs'

const preciseId = (value, label) => {
  const text = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : ''
  if (!/^[1-9]\d*$/.test(text) || BigInt(text) > 9223372036854775807n) {
    throw new Error(`${label} did not return an exact database ID`)
  }
  return text
}

export const costModelPayload = ({ versionNo, effectiveMonth, remark }) => ({
  accountingOrgId: 1,
  versionNo,
  enterpriseType: 'MANUFACTURING',
  dimensionMode: '产品',
  valuationScopeMode: 'GLOBAL',
  valuationMethod: 'MOVING_AVERAGE',
  valuationScopeConfigJson: JSON.stringify({
    finishedDataSourceMode: 'MANUAL',
    productionOrderDataSourceMode: 'MANUAL'
  }),
  finishedIoScopeJson: '[]',
  productionOrderScopeJson: '[]',
  effectiveMonth,
  remark
})

export async function prepareCostModelFixture ({
  api, caseId, record, caseRecord, effectiveMonth, remarkForFixture
}, dependencies = {}) {
  if (caseRecord.fixtures?.cost) return caseRecord.fixtures.cost
  if (config.target !== 'local' || config.tenantId !== '1' ||
      String(record.environment?.tenantId) !== '1' ||
      !['COST-030', 'COST-031', 'COST-032'].includes(caseId) ||
      caseRecord.id !== caseId || caseRecord.caseId !== caseId ||
      !/^[A-Za-z0-9_-]+$/.test(record.runId || '') || effectiveMonth !== '2099-12') {
    throw new Error('BLOCKED: cost fixtures require the authorized local tenant and exact case/run scope')
  }
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()
  const fixture = {
    caseId, runId: record.runId,
    fixtureId: `E2E-${caseId}-${record.runId}-${suffix}`,
    tenantId: '1', accountingOrgId: '1', effectiveMonth, exclusive: true
  }
  const remark = remarkForFixture(fixture)
  caseRecord.fixtures = { ...(caseRecord.fixtures || {}), cost: fixture }
  const department = await api.postBusiness('/system/dept/create', {
    name: `E2E-COST-${suffix}`, code: `E2E-COST-${suffix}`,
    unitType: 'DEPARTMENT', parentId: '0', sort: 9999, status: 0
  })
  fixture.departmentId = preciseId(department.data, 'Cost fixture department')
  const center = await api.postBusiness('/cost/centers', {
    accountingOrgId: 1,
    code: `E2E-COST-${suffix}`,
    name: `E2E成本专属中心${suffix}`,
    enabledAt: `${effectiveMonth}-01`,
    departmentIds: [fixture.departmentId],
    remark
  })
  fixture.costCenterId = preciseId(center.data?.id, 'Cost fixture center')
  const model = await api.postBusiness('/cost/model-versions', costModelPayload({
    versionNo: `E2E-${caseId}-${suffix}`, effectiveMonth, remark
  }))
  fixture.modelVersionId = preciseId(model.data?.id, 'Cost fixture model')
  const components = await api.putBusiness(`/cost/model-versions/${fixture.modelVersionId}/components`, {
    categories: [{
      id: 'fixture-category', parentId: '', code: `E2E-CAT-${suffix}`,
      name: 'E2E成本专属分类', sortNo: 100, status: 'ENABLED'
    }],
    items: [{
      id: 'fixture-item', categoryId: 'fixture-category', code: `E2E-ITEM-${suffix}`,
      name: 'E2E成本专属构成项', inclusionRate: 100, fetchMode: 'MANUAL',
      resultScope: 'FORMAL_COST', businessDirection: 'COST',
      systemItem: false, participateWip: true, status: 'ENABLED', remark
    }],
    sourceRules: [{
      id: 'fixture-source', componentItemId: 'fixture-item',
      sourceType: 'E2E_MANUAL', sourcePriority: 1,
      effectiveFrom: `${effectiveMonth}-01`, status: 'ENABLED'
    }]
  })
  if (components.data?.items?.length !== 1) {
    throw new Error('Cost fixture component creation did not return the dedicated item')
  }
  fixture.componentItemId = preciseId(components.data.items[0].id, 'Cost fixture component')
  caseRecord.evidence.push(`专属成本前置：${JSON.stringify(fixture)}`)
  caseRecord.checks.push({
    name: '通过正式 API 建立本案例本轮专属部门、远期成本中心、草稿模型和构成项',
    passed: true,
    details: `tenant=1 department=${fixture.departmentId} center=${fixture.costCenterId} model=${fixture.modelVersionId} item=${fixture.componentItemId}`
  })
  return fixture
}

export async function createLockedCostModelFixture ({ api, record, caseRecord, remark }) {
  const lockedMonths = new Set()
  let pageNo = 1
  while (true) {
    const response = await api.getBusiness(`/cost/model-versions?accountingOrgId=1&pageNo=${pageNo}&pageSize=100`)
    if (!Array.isArray(response.data?.list) || !Number.isSafeInteger(response.data?.total)) {
      throw new Error('Locked model preflight returned a malformed page')
    }
    for (const model of response.data.list) {
      if (model.status === 'LOCKED' && model.enterpriseType === 'MANUFACTURING') {
        lockedMonths.add(model.effectiveMonth)
      }
    }
    if (pageNo * 100 >= response.data.total) break
    pageNo++
  }
  const year = 2100 + Math.floor(lockedMonths.size / 12)
  const effectiveMonth = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
    .find((month) => !lockedMonths.has(month))
  if (!effectiveMonth) throw new Error('No unused future month for the dedicated locked model')
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()
  const created = await api.postBusiness('/cost/model-versions', costModelPayload({
    versionNo: `E2E-LOCK-${suffix}`, effectiveMonth, remark
  }))
  const id = preciseId(created.data?.id, 'Locked cost fixture')
  caseRecord.fixtures.cost.lockedModelId = id
  caseRecord.fixtures.cost.lockedModelMonth = effectiveMonth
  const locked = await api.postBusiness(`/cost/model-versions/${id}/lock`)
  if (locked.data?.status !== 'LOCKED' || locked.data?.remark !== remark) {
    throw new Error('Dedicated cost model was not locked with the expected ownership')
  }
  caseRecord.evidence.push(`专属锁定模型：id=${id} month=${effectiveMonth} run=${record.runId}`)
  return { id, effectiveMonth }
}
