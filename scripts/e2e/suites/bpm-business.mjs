import assert from 'node:assert/strict'
import { config } from '../config/index.mjs'
import { createApiClient } from '../lib/api.mjs'
import { assertLocalWriteSafety } from '../lib/db.mjs'
import { login, observePage, openRoute, saveScreenshot } from '../lib/browser.mjs'
import {
  assertSalesLocalScope, createSalesFixture, createSalesSettlementAccount,
  resolveSalesApproverCredential, salesTime
} from './erp-sales.mjs'

export const cases = ['BPM-BUSINESS-001']

export const approvalValues = {
  approvedQty: { label: '实收实发数量', value: 2 },
  approvedWarehouse: { label: '确认仓库', value: 'E2E 仓库确认' },
  approvedLocation: { label: '确认库位', value: 'E2E 库位确认' },
  approvedUnitPrice: { label: '审批单价', value: 88.8 },
  taxRate: { label: '税率', value: 0 },
  paymentTerms: { label: '付款条件', value: 'E2E 按合同约定' },
  receiptTerms: { label: '收款条件', value: 'E2E 按合同约定' }
}

export function validateApprovalSnapshot(variables, expected) {
  assert.equal(variables?.billNo, expected.no, '审批单号必须与本轮业务单据一致')
  assert.equal(Number(variables?.quantity), 2, '审批数量不能为空或来自其它单据')
  assert.equal(Number(variables?.amount), 177.6, '审批金额必须来自正式单据')
  assert.equal(variables?.partnerName, expected.tag, '审批客商名称必须是本轮专属客商')
  assert.ok(variables?.creatorName, '审批制单人不能为空')
  assert.ok(variables?.businessDate, '审批业务日期不能为空')
  assert.equal(variables?.items?.length, 1, '审批明细不能为空')
  const item = variables.items[0]
  assert.equal(String(item.productId), String(expected.materialId))
  assert.equal(item.productCode, expected.tag)
  assert.equal(item.productName, expected.tag)
  assert.ok(item.productUnitName, '审批明细单位名称不能为空')
  assert.ok(item.warehouseName, '审批明细仓库名称不能为空')
  assert.equal(Number(item.count), 2)
  assert.equal(Number(item.productPrice), 88.8)
}

function fact(caseRecord, name, passed, details = '') {
  caseRecord.checks.push({ name, passed, details })
  assert.ok(passed, `${name}: ${details}`)
}

const credentialOptions = {
  configured: [
    { username: config.warehouseApproverUsername, password: config.warehouseApproverPassword },
    { username: config.warehouseFinalApproverUsername, password: config.warehouseFinalApproverPassword },
    { username: config.financeApproverUsername, password: config.financeApproverPassword },
    { username: config.finalApproverUsername, password: config.finalApproverPassword }
  ]
}

export async function runCase({ page, record, caseRecord, outputDir }) {
  assertSalesLocalScope()
  const auth = await login(page, { returnContext: true })
  assert.equal(String(auth.tenantId), '1')
  const api = createApiClient({ token: auth.token, tenantId: '1', record })
  await assertLocalWriteSafety(caseRecord)
  const identity = (await api.getBusiness('/system/auth/get-permission-info')).data.user
  const fixture = await createSalesFixture(api, caseRecord, identity.id, { warehouse: true })
  const account = await createSalesSettlementAccount(api, caseRecord, fixture.tag)
  const values = {
    ...approvalValues,
    approvedQty: { ...approvalValues.approvedQty, value: 3 },
    approvedWarehouse: { ...approvalValues.approvedWarehouse, value: fixture.warehouseId },
    approvedLocation: { ...approvalValues.approvedLocation, value: fixture.locationId }
  }
  const outId = (await api.postBusiness('/erp/sale-out/create', {
    businessType: 'OPENING', customerId: fixture.partnerId, accountId: account.id,
    outTime: salesTime(), goLiveBaseDate: salesTime().slice(0, 10), openingInvoicedAmount: 0,
    discountPercent: 0, otherPrice: 0, remark: fixture.tag,
    items: [{
      warehouseId: fixture.warehouseId, productId: fixture.material.id,
      productUnitId: fixture.material.unitId, productPrice: 88.8, count: 2, taxPercent: 0
    }]
  })).data
  caseRecord.fixtures.push({ kind: 'approval-sale-out', id: outId, tenantId: 1, owned: true, tag: fixture.tag })
  let processId
  const sessions = new Map([[String(identity.id), { page, api, username: identity.username }]])
  const contexts = []
  const captures = []
  const submitted = []
  const pageErrors = []
  try {
    await api.putBusiness(`/erp/sale-out/update-status?id=${outId}&status=20`)
    const out = (await api.getBusiness(`/erp/sale-out/get?id=${outId}`)).data
    processId = out.processInstanceId
    assert.match(processId || '', /^[0-9a-f-]{36}$/i)
    caseRecord.evidence.push(`tag=${fixture.tag}, saleOutId=${outId}, processInstanceId=${processId}`)
    const expected = { no: out.no, tag: fixture.tag, materialId: fixture.material.id }
    const startDetail = (await api.getBusiness(
      `/bpm/process-instance/get-approval-detail?processInstanceId=${processId}`)).data
    validateApprovalSnapshot(startDetail.processInstance.formVariables, expected)
    fact(caseRecord, '发起审批已携带本轮业务头、明细、客商和制单人快照', true, processId)

    for (let step = 0; step < 12; step++) {
      const tasks = (await api.getBusiness(
        `/bpm/task/list-by-process-instance-id?processInstanceId=${processId}`)).data
      const active = tasks.filter((task) => !task.endTime && Number(task.status) === 1)
      if (!active.length) break
      for (const task of active) {
        const assignee = task.assigneeUser
        assert.ok(assignee?.id, '审批节点必须有实际审批人')
        const assigneeId = String(assignee.id)
        if (!sessions.has(assigneeId)) {
          const user = (await api.getBusiness(`/system/user/get?id=${assigneeId}`)).data
          const credentials = resolveSalesApproverCredential(user.username, credentialOptions)
          if (!credentials) throw new Error(`BLOCKED: 实际审批账号 ${user.username} 没有现有本地测试凭据`)
          const context = await page.context().browser().newContext({
            viewport: { width: 1600, height: 900 }, locale: 'zh-CN'
          })
          contexts.push(context)
          const approvalPage = await context.newPage()
          captures.push(observePage(approvalPage, record))
          approvalPage.on('pageerror', (error) => pageErrors.push(error.message))
          approvalPage.on('console', (message) => {
            if (message.type() === 'error') pageErrors.push(message.text())
          })
          const approvalAuth = await login(approvalPage, {
            credentials: { ...credentials, tenantName: config.tenantName }, returnContext: true
          })
          assert.equal(String(approvalAuth.tenantId), '1')
          const approverApi = createApiClient({ token: approvalAuth.token, tenantId: '1', record })
          const verified = (await approverApi.getPermissionInfo()).data.user
          assert.equal(String(verified.id), assigneeId)
          sessions.set(assigneeId, { page: approvalPage, api: approverApi, username: verified.username })
        }
        const session = sessions.get(assigneeId)
        const detail = (await session.api.getBusiness(
          `/bpm/process-instance/get-approval-detail?processInstanceId=${processId}&taskId=${task.id}`)).data
        assert.equal(detail.todoTask?.id, task.id, '实际账号必须取得本节点待办')
        validateApprovalSnapshot(detail.processInstance.formVariables, expected)
        await openRoute(session.page,
          `/bpm/process-instance/detail?id=${processId}&taskId=${task.id}`,
          { readySelector: '.form-box input[placeholder="单据编号"]' })
        fact(caseRecord, '审批页面单号非空且显示本轮单据',
          await session.page.getByPlaceholder('单据编号', { exact: true }).inputValue() === out.no, task.id)
        const renderedValues = await session.page.locator('.form-box input').evaluateAll(
          (inputs) => inputs.map((input) => input.value))
        fact(caseRecord, '审批明细实际显示物料编码及名称，不以API有值代替页面展示',
          renderedValues.filter((value) => value === fixture.tag).length >= 3, task.id)
        const inputs = {}
        for (const [field, input] of Object.entries(values)) {
          const control = session.page.getByPlaceholder(input.label, { exact: true })
          const permission = detail.formFieldsPermission?.[field]
          if (permission === '2') {
            fact(caseRecord, `${task.name}的${input.label}可填写`, await control.isEditable(), task.id)
            await control.fill(String(input.value))
            inputs[field] = input.value
          } else if (permission === '1' && await control.isVisible()) {
            fact(caseRecord, `${task.name}的${input.label}保持只读`, !(await control.isEditable()), task.id)
          }
        }
        await saveScreenshot(session.page, outputDir, `bpm-business-${step}-${task.taskDefinitionKey}`, record)
        const approve = session.page.locator('.btn-container').getByRole('button', { name: /通过|同意/ }).first()
        await approve.click()
        const popover = session.page.locator('.el-popover:visible').last()
        await popover.locator('textarea').fill(`${fixture.tag} 节点填写验证`)
        const responsePromise = session.page.waitForResponse((response) =>
          response.url().includes('/bpm/task/approve') && response.request().method() === 'PUT')
        await popover.getByRole('button', { name: /通过|同意/ }).click()
        const response = await responsePromise
        assert.equal(response.status(), 200)
        const payload = response.request().postDataJSON()
        for (const [field, value] of Object.entries(inputs)) {
          fact(caseRecord, `浏览器审批请求携带${field}`, payload.variables?.[field] === value, task.id)
        }
        const history = (await api.getBusiness(
          `/bpm/task/list-by-process-instance-id?processInstanceId=${processId}`)).data
        const completed = history.find((entry) => entry.id === task.id)
        fact(caseRecord, '审批请求成功后历史任务正式结束且通过',
          Boolean(completed?.endTime) && Number(completed.status) === 2, task.id)
        validateApprovalSnapshot(completed.formVariables, expected)
        for (const [field, value] of Object.entries(inputs)) {
          fact(caseRecord, `历史表单保留本节点${field}`, completed.formVariables[field] === value, task.id)
        }
        submitted.push({ taskId: task.id, node: task.name, fields: Object.keys(inputs) })
      }
    }
    const final = (await api.getBusiness(`/bpm/process-instance/get?id=${processId}`)).data
    fact(caseRecord, '同一业务审批连续走完所有节点并正式通过',
      Boolean(final.endTime) && Number(final.status) === 2, processId)
    const finalOut = (await api.getBusiness(`/erp/sale-out/get?id=${outId}`)).data
    const finalItem = finalOut?.items?.[0]
    fact(caseRecord, '审批终态按节点填写回写业务明细数量与仓库',
      Number(finalItem?.count) === 3 &&
      String(finalItem?.warehouseId) === String(fixture.warehouseId),
      `saleOutId=${outId}, count=${finalItem?.count}, warehouseId=${finalItem?.warehouseId}`)
    fact(caseRecord, '仓库和财务节点均实际填写字段',
      submitted.some((entry) => entry.fields.includes('approvedQty')) &&
      submitted.some((entry) => entry.fields.includes('approvedUnitPrice')), JSON.stringify(submitted))
    await openRoute(page, `/bpm/process-instance/detail?id=${processId}`, {
      readySelector: '.form-box input[placeholder="单据编号"]'
    })
    await page.getByRole('tab', { name: '流转记录' }).click()
    await page.getByRole('button', { name: '查看表单' }).first().click()
    const dialog = page.getByRole('dialog').filter({ hasText: '表单详情' })
    await dialog.getByPlaceholder('单据编号', { exact: true }).waitFor({ state: 'visible' })
    fact(caseRecord, '流转记录历史弹窗显示已填写业务单号',
      await dialog.getByPlaceholder('单据编号', { exact: true }).inputValue() === out.no)
    await saveScreenshot(page, outputDir, 'bpm-business-history-dialog', record)
    fact(caseRecord, '所有实际审批账号页面无控制台及运行时异常', pageErrors.length === 0, JSON.stringify(pageErrors))
    const catalog = await import('../cases/catalog.json', { with: { type: 'json' } })
    const definition = catalog.default.suites.find((suite) => suite.id === 'bpm-business').cases[0]
    caseRecord.catalogAssertions = definition.assertions.map((assertion, index) =>
      ({ index, assertion, status: 'VERIFIED' }))
    caseRecord.notes.push('保留专属审批历史和业务单据。此案例不证明审批补录已回写ERP金额或WMS实物库存。')
    return {}
  } finally {
    if (processId) {
      const current = (await api.getBusiness(`/bpm/process-instance/get?id=${processId}`)).data
      if (!current.endTime) {
        await api.request('DELETE', '/bpm/process-instance/cancel-by-start-user', {
          id: processId, reason: `${fixture.tag} 本轮失败后正式取消，保留历史`
        }).then((result) => assert.equal(result.code, 0))
      }
    }
    for (const context of contexts) await context.close()
    await Promise.all(captures.map((capture) => capture.flushResponses()))
  }
}
