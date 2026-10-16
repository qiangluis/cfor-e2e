import { randomUUID } from 'node:crypto'
import { config } from '../config/index.mjs'
import { matchesExpectedBusinessRejection } from '../lib/api.mjs'

const id = (value) => {
  const result = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : ''
  return /^[1-9]\d*$/.test(result) && BigInt(result) <= 9223372036854775807n ? result : null
}

export const costWritesEnabled = () => process.env.CFOR_E2E_WRITE_FIXTURES === 'true'

export async function scopedCostScenarioApi ({ api, record, caseRecord, settings = config }) {
  const fixture = caseRecord.fixtures?.costScenario
  if (settings.target !== 'local' || String(settings.tenantId) !== '1' ||
      String(record.environment?.tenantId) !== '1' ||
      fixture?.runId !== record.runId || fixture?.tenantId !== '1' ||
      !fixture?.remark?.startsWith(`CFOR-E2E:costScenario:${fixture.scenario}:${record.runId}:`) ||
      !id(fixture.modelId) || !id(fixture.periodId)) {
    throw new Error('BLOCKED: cost period writes require exact local tenant1/run registration')
  }
  const model = (await api.getBusiness(`/cost/model-versions/${fixture.modelId}`)).data
  if (String(model?.id) !== fixture.modelId || model?.remark !== fixture.remark ||
      String(model.accountingOrgId) !== '1' || model?.versionNo !== fixture.versionNo) {
    throw new Error('BLOCKED: cost scenario model ownership changed')
  }
  const periodIds = new Set([
    fixture.periodId, fixture.accountingPeriodId, fixture.publishedPeriodId
  ].filter(Boolean).map((value) => {
    if (!id(value)) throw new Error('BLOCKED: invalid registered cost period ID')
    return id(value)
  }))
  const trialIds = new Set()
  const publicationIds = new Set()
  for (const periodId of periodIds) {
    const period = (await api.getBusiness(`/cost/periods/${periodId}`)).data
    if (String(period?.id) !== periodId || String(period?.accountingOrgId) !== '1' ||
        String(period.modelVersionId) !== fixture.modelId ||
        period.modelVersionNo !== fixture.versionNo ||
        ![fixture.month, fixture.accountingMonth].includes(period.period)) {
      throw new Error('BLOCKED: registered cost period ownership changed')
    }
    if (period.currentTrialId) trialIds.add(String(period.currentTrialId))
    if (period.currentPublicationId) publicationIds.add(String(period.currentPublicationId))
  }
  const negative = caseRecord.fixtures?.costUnpublishedScenario
  if (negative) {
    await scopedCostScenarioApi({
      api, record, caseRecord: { fixtures: { costScenario: negative } }, settings
    })
    const negativePeriod = (await api.getBusiness(`/cost/periods/${negative.periodId}`)).data
    if (negativePeriod.status !== 'ACCOUNTING' || negativePeriod.currentPublicationId) {
      throw new Error('BLOCKED: unpublished cost negative fixture is no longer accounting')
    }
    periodIds.add(negative.periodId)
  }
  const guard = (method, pathname, body) => {
    if (method === 'GET') return
    const path = new URL(pathname, 'http://local.test').pathname
    if (path === '/cost/periods' && method === 'POST') {
      if (String(body?.accountingOrgId) === '1' &&
          body?.modelVersion === fixture.versionNo &&
          [fixture.month, fixture.accountingMonth].includes(body?.period)) return
    }
    const period = path.match(/^\/cost\/periods\/(\d+)(?:\/|$)/)
    const trial = path.match(/^\/cost\/trials\/(\d+)(?:\/|$)/)
    const publication = path.match(/^\/cost\/publications\/(\d+)(?:\/|$)/)
    if (period && periodIds.has(period[1])) return
    if (trial && trialIds.has(trial[1])) return
    if (publication && publicationIds.has(publication[1])) return
    throw new Error(`BLOCKED: refused non-owned cost mutation ${method} ${path}`)
  }
  const wrap = (method, call) => async (pathname, body, options) => {
    guard(method, pathname, body)
    const result = await call(pathname, body, options)
    const url = new URL(pathname, 'http://local.test')
    if (method === 'GET' && url.pathname === '/cost/periods') {
      if (result?.code !== 0 || !Array.isArray(result.data?.list) ||
          !Number.isSafeInteger(result.data.total)) {
        throw new Error('Cost period scope received a malformed list')
      }
      const list = []
      for (const periodId of periodIds) {
        const period = (await api.getBusiness(`/cost/periods/${periodId}`)).data
        list.push(period)
      }
      return { ...result, data: { ...result.data, list, total: list.length } }
    }
    return result
  }
  return {
    ...api,
    request: async (method, pathname, body, options) => {
      guard(method, pathname, body)
      return api.request(method, pathname, body, options)
    },
    getBusiness: wrap('GET', (pathname, options) => api.getBusiness(pathname, options)),
    postBusiness: wrap('POST', (...args) => api.postBusiness(...args)),
    putBusiness: wrap('PUT', (...args) => api.putBusiness(...args)),
    post: wrap('POST', (...args) => api.post(...args)),
    put: wrap('PUT', (...args) => api.put(...args)),
    deleteBusiness: async (pathname, options) => {
      guard('DELETE', pathname)
      return api.deleteBusiness(pathname, options)
    },
    delete: async (pathname, options) => {
      guard('DELETE', pathname)
      return api.delete(pathname, options)
    }
  }
}

export async function prepareDedicatedCostDepartment ({ api, record, caseRecord }) {
  const marker = `CFOR-E2E:${caseRecord.id}:${record.runId}:tenant=1:department`
  const name = `E2E-${caseRecord.id}-${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const response = await api.postBusiness('/system/dept/create', {
    name, code: name, parentId: '0', sort: 9999, status: 0, unitType: 'DEPARTMENT'
  })
  const departmentId = id(response.data)
  if (!departmentId) throw new Error('Dedicated cost department returned an imprecise ID')
  const fixture = { id: departmentId, name, marker }
  caseRecord.fixtures = { ...(caseRecord.fixtures || {}), costDepartment: fixture }
  const row = (await api.getBusiness(`/system/dept/get?id=${departmentId}`)).data
  if (String(row?.id) !== departmentId || row?.name !== name ||
      row?.code !== name || Number(row.status) !== 0) {
    throw new Error('Dedicated cost department ownership could not be reread')
  }
  return fixture
}

export async function cleanupDedicatedCostDepartment ({ api, caseRecord }) {
  const fixture = caseRecord.fixtures?.costDepartment
  if (!fixture) return
  const current = (await api.getBusiness(`/system/dept/get?id=${fixture.id}`)).data
  if (String(current?.id) !== fixture.id || current?.name !== fixture.name ||
      current?.code !== fixture.name) {
    throw new Error('Dedicated cost department cleanup refused ownership drift')
  }
  await api.deleteBusiness(`/system/dept/delete?id=${fixture.id}`)
  const after = await api.get(`/system/dept/get?id=${fixture.id}`)
  const removed = after?.code === 0 && after.data == null ||
    matchesExpectedBusinessRejection(after, { code: 1002004002, message: '当前部门不存在' })
  caseRecord.checks.push({
    name: 'COST-029 专属部门正式删除并回读不可见',
    passed: removed, details: `department=${fixture.id}; code=${after?.code}`
  })
  if (!removed) throw new Error('Dedicated cost department deletion not proven')
}
