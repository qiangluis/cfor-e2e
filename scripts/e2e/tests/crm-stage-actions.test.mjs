import assert from 'node:assert/strict'
import test from 'node:test'
import {
  crmStageActionCodes,
  crmStageActionInternals,
  runCrmStageActions
} from '../fixtures/crm-stage-actions.mjs'

test('CRM-BASE-005 fixture exposes the three stable action codes', () => {
  assert.deepEqual(crmStageActionCodes, ['CREATE_QUOTE', 'CREATE_CONTRACT', 'TRANSFER_OWNER'])
})

test('CRM-BASE-005 fixture rejects an incomplete shared-stage context', () => {
  assert.throws(() => crmStageActionInternals.requiredContext({
    api: {}, caseRecord: {}, userId: '1', customerId: '2', tag: 'E2E',
    type: { id: '10' }, stages: [{ id: '11' }], createBusiness: () => {}
  }), /至少四个专属阶段/)
})

test('CRM-BASE-005 fixture runs action rules without a browser and records the quote qualification GAP',
  async () => {
    const businesses = new Map()
    const rules = new Map()
    let nextBusinessId = 500
    let nextRuleId = 800
    const api = {
      async getBusiness(path) {
        if (path === '/crm/business-stage-rule/action-catalog') {
          return { code: 0, data: crmStageActionCodes.map((code) => ({ code, name: code })) }
        }
        if (path === '/system/auth/get-permission-info') {
          return { code: 0, data: { user: { id: '7', deptId: '77' } } }
        }
        if (path === '/system/user/simple-list') {
          return { code: 0, data: [{ id: '7' }, { id: '8' }] }
        }
        if (path.startsWith('/crm/business-stage-rule/page')) {
          return { code: 0, data: { list: [...rules.values()], total: rules.size } }
        }
        if (path.startsWith('/crm/business/get?id=')) {
          const id = new URL(`http://fixture${path}`).searchParams.get('id')
          return { code: 0, data: businesses.get(id) || null }
        }
        throw new Error(`unexpected GET ${path}`)
      },
      async postBusiness(path, body) {
        assert.equal(path, '/crm/business-stage-rule/create')
        const id = String(nextRuleId++)
        rules.set(id, { id, statusGroupId: body.statusGroupId, statusId: body.statusId,
          items: body.items, applicableOrgIds: body.applicableOrgIds, versionNo: body.versionNo })
        return { code: 0, data: id }
      },
      async putBusiness(path, body) {
        if (path === '/crm/business/update-status') {
          const business = businesses.get(String(body.id))
          business.statusId = String(body.statusId)
          return { code: 0, data: true }
        }
        if (path === '/crm/business/transfer') {
          const business = businesses.get(String(body.id))
          business.ownerUserId = String(body.newOwnerUserId)
          return { code: 0, data: true }
        }
        throw new Error(`unexpected PUT ${path}`)
      },
      async request(method, path, body) {
        if (method === 'POST' && path === '/crm/quote/create') {
          return { code: 1020017006, msg: '报价来源商机的报价资格必须已通过' }
        }
        if (method === 'PUT' && path === '/crm/business/transfer') {
          return { code: 1020017005, msg: '当前阶段不允许动作 TRANSFER_OWNER' }
        }
        throw new Error(`unexpected REQUEST ${method} ${path} ${JSON.stringify(body)}`)
      },
      async deleteBusiness(path) {
        if (path.startsWith('/crm/business-stage-rule/delete?id=')) {
          rules.delete(new URL(`http://fixture${path}`).searchParams.get('id'))
        } else if (path.startsWith('/crm/business/delete?id=')) {
          businesses.delete(new URL(`http://fixture${path}`).searchParams.get('id'))
        } else {
          throw new Error(`unexpected DELETE ${path}`)
        }
        return { code: 0, data: true }
      }
    }
    const caseRecord = { checks: [], notes: [], fixtures: [] }
    const stages = ['101', '102', '103', '104'].map((id) => ({ id }))
    const result = await runCrmStageActions({
      api,
      caseRecord,
      userId: '7',
      customerId: '9',
      tag: 'E2E-CRM-STAGE',
      type: { id: '100' },
      stages,
      createBusiness: async ({ stageId }) => {
        const id = String(nextBusinessId++)
        businesses.set(id, {
          id,
          customerId: '9',
          ownerUserId: '7',
          statusTypeId: '100',
          statusId: String(stageId)
        })
        return { id, detail: businesses.get(id) }
      }
    })

    assert.equal(result.partial, true)
    assert.match(caseRecord.notes.join('\n'), /没有报价资格申请\/审批正式 API/)
    assert.equal(caseRecord.checks.find((check) => check.name.includes('未配置 ACTION'))?.passed, true)
    assert.equal(caseRecord.checks.find((check) => check.name.includes('TRANSFER_OWNER 白名单允许'))?.passed, true)
    assert.equal(caseRecord.checks.find((check) => check.name.includes('TRANSFER_OWNER 不在'))?.passed, true)
    assert.equal(caseRecord.checks.find((check) => check.name.includes('分页一次性返回 items'))?.passed, true)
    assert.equal(rules.size, 0)
    assert.equal(businesses.size, 0)
  })
