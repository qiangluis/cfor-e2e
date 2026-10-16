import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { observePage } from '../lib/browser.mjs'
import {
  assertAssetProfileWrite,
  assertExpiredAssetRiskRow,
  assertDutyPagePersistence,
  assertDutyRosterRow,
  assertDutyRuleWrite,
  assertIssueCategoryForm,
  assertIssueCategoryWrite,
  isExpectedAssetProfileResponse,
  pageStorageKeysForAfterSales,
  readIssueCategoryForm,
  reloadAfterSalesSettingsTab
} from '../fixtures/project-after-sales-browser.mjs'

const categoryExpected = {
  categoryCode: 'E2E-CATEGORY-X', persistedName: '页面已保存',
  productType: 'STANDARD', assetType: 'SOFTWARE', serviceStatus: 'IN_SERVICE'
}
const categoryForm = {
  categoryCode: categoryExpected.categoryCode, categoryName: categoryExpected.persistedName,
  productLabel: 'STANDARD', assetLabel: 'SOFTWARE', serviceLabel: '服务中'
}

test('PB120 读取每个 Select 的选中标签，不把空搜索 input 当服务状态', async () => {
  const fields = {
    模型编码: { input: categoryForm.categoryCode },
    模型名称: { input: categoryForm.categoryName },
    适用产品类型: { input: '', selected: categoryForm.productLabel },
    适用资产类型: { input: '', selected: categoryForm.assetLabel },
    适用服务状态: { input: '', selected: categoryForm.serviceLabel }
  }
  const dialog = {
    locator: (selector) => {
      assert.equal(selector, '.el-form-item')
      return {
        filter: ({ hasText }) => ({
          locator: (fieldSelector) => {
            const field = fields[hasText]
            assert.ok(field, `unexpected field ${hasText}`)
            if (fieldSelector === 'input, textarea') {
              return { first: () => ({ inputValue: async () => field.input }) }
            }
            assert.equal(fieldSelector,
              '.el-select__selection > .el-select__selected-item:not(.el-select__input-wrapper)')
            return { innerText: async () => field.selected }
          }
        })
      }
    }
  }
  const form = await readIssueCategoryForm(dialog)
  assert.deepEqual(form, categoryForm)
  assert.equal(assertIssueCategoryForm(form, categoryExpected), true)
})

test('PB120 按字段精确验证，空状态、错误状态和其他字段中的正确文字不能通过', () => {
  for (const change of [
    { categoryCode: '另一个编码' }, { categoryName: '旧分类名称' },
    { productLabel: '' }, { assetLabel: '服务器' },
    { serviceLabel: '' }, { serviceLabel: '全部服务状态' },
    { serviceLabel: '暂停服务' }, { serviceLabel: '服务到期' },
    { serviceLabel: '服务中（错误附加内容）' },
    { categoryName: '服务中', serviceLabel: '全部服务状态' }
  ]) {
    assert.throws(() => assertIssueCategoryForm({ ...categoryForm, ...change }, categoryExpected),
      /刷新表单字段不一致/)
  }
  for (const [serviceStatus, serviceLabel] of [
    ['IN_SERVICE', '服务中'],
    ['SERVICE_SUSPENDED', '暂停服务'],
    ['SERVICE_EXPIRED', '服务到期']
  ]) {
    assert.equal(assertIssueCategoryForm({ ...categoryForm, serviceLabel },
      { ...categoryExpected, serviceStatus }), true)
  }
  assert.equal(assertIssueCategoryForm({
    ...categoryForm, productLabel: '软件系统', assetLabel: '软件许可'
  }, { ...categoryExpected, productType: 'SOFTWARE', assetType: 'LICENSE' }), true)
})

test('PB125 到期风险行必须含本轮资产、真实期限和到期提示，空白或别的资产不能通过', () => {
  const expected = { assetNo: 'PB125-EXPIRED-X', startDate: '2026-07-12', endDate: '2026-09-10' }
  assert.equal(assertExpiredAssetRiskRow('PB125-EXPIRED-X 2026-07-12 至 2026-09-10 服务到期', expected), true)
  for (const text of [
    '', '服务到期', 'PB125-OTHER 2026-07-12 至 2026-09-10 服务到期',
    'PB125-EXPIRED-X 2026-07-12 至 2026-09-10 服务中',
    'PB125-EXPIRED-X 2026-07-12 至 2027-09-10 服务到期'
  ]) assert.throws(() => assertExpiredAssetRiskRow(text, expected), /页面真实内容不完整/)
})
class ReloadPage extends EventEmitter {
  events = []
  reloadCount = 0
  async evaluate () {
    this.events.push('clear-page-state')
    return []
  }
  async reload (options) {
    assert.equal(options.waitUntil, 'domcontentloaded')
    this.reloadCount++
    this.events.push('reload')
    this.onReload?.()
  }
  async goto () {
    throw new Error('刷新后不应再发起第二次导航')
  }
  async waitForFunction () {
    this.events.push('page-ready')
  }
  locator (selector) {
    const page = this
    return {
      filter: ({ hasText }) => {
        assert.equal(selector, '.el-tabs__item')
        assert.equal(hasText, '值班服务')
        return { first: () => ({
          waitFor: async () => page.events.push('tab-visible'),
          click: async () => page.events.push('select-tab')
        }) }
      },
      waitFor: async ({ state }) => page.events.push(`${selector}:${state}`),
      innerText: async () => '售后建模 值班服务'
    }
  }
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve))

const trackApiResponse = (page, pathname, readBody) => {
  const request = {
    method: () => 'GET',
    url: () => `http://127.0.0.1:48083/admin-api${pathname}`
  }
  page.emit('request', request)
  page.emit('response', {
    request: () => request, url: request.url, status: () => 200,
    headers: () => ({ 'content-type': 'application/json' }),
    text: readBody
  })
  return () => page.emit('requestfinished', request)
}

test('售后刷新先等旧响应体检查，刷新后等新启动响应，只刷新一次且不再次导航', async () => {
  const page = new ReloadPage()
  const record = { failedApiResponses: [] }
  observePage(page, record)
  let resolveBody
  const body = new Promise((resolve) => { resolveBody = resolve })
  const finish = trackApiResponse(page, '/infra/config/get-value-by-key', async () => {
    page.events.push('old-response-body')
    return body
  })
  page.onReload = () => {
    const finishBootstrap = trackApiResponse(page, '/system/auth/get-permission-info', async () => {
      page.events.push('bootstrap-response-body')
      return '{"code":0,"data":{},"msg":""}'
    })
    setImmediate(finishBootstrap)
  }
  const refresh = reloadAfterSalesSettingsTab(page, '值班服务')
  await nextTurn()
  assert.equal(page.reloadCount, 0)
  assert.ok(!page.events.includes('clear-page-state'))
  finish()
  await nextTurn()
  assert.ok(page.events.includes('old-response-body'))
  assert.equal(page.reloadCount, 0)
  resolveBody('{"code":0,"data":true,"msg":""}')
  assert.equal(await refresh, '售后建模 值班服务')
  assert.equal(page.reloadCount, 1)
  assert.ok(page.events.indexOf('old-response-body') < page.events.indexOf('clear-page-state'))
  assert.ok(page.events.includes('bootstrap-response-body'))
  assert.deepEqual(record.failedApiResponses, [])
})

test('PB125 多资产客户保存时只等待目标资产响应，不误收同客户其他资产的先到响应', () => {
  const expected = { customerId: '101', assetId: '202' }
  const response = (body) => ({
    url: () => 'http://127.0.0.1:48083/admin-api/after-sales/asset/customer-profile/update',
    request: () => ({
      method: () => 'PUT', headers: () => ({}), postDataJSON: () => body
    })
  })
  assert.equal(isExpectedAssetProfileResponse(response({ customerId: '101', assets: [{ id: '203' }] }),
    expected), false)
  assert.equal(isExpectedAssetProfileResponse(response({ customerId: '999', assets: [{ id: '202' }] }),
    expected), false)
  assert.equal(isExpectedAssetProfileResponse(response({ customerId: '101', assets: [{ id: '202' }] }),
    expected), true)
  assert.equal(isExpectedAssetProfileResponse(response({ customerId: '101', assets: [] }), expected), false)
})

test('售后刷新前真实观察器 pending 必须拒绝，不清状态、不导航、不吞错', async () => {
  const page = new ReloadPage()
  const capture = observePage(page)
  const flush = capture.flushResponses.bind(capture)
  capture.flushResponses = () => flush({ timeoutMs: 20, quietMs: 1 })
  const finish = trackApiResponse(page, '/infra/config/get-value-by-key',
    async () => '{"code":0,"data":true,"msg":""}')
  await assert.rejects(reloadAfterSalesSettingsTab(page, '值班服务'),
    /响应检查未完成，禁止复用当前上下文.*infra\/config\/get-value-by-key/)
  assert.deepEqual(page.events, [])
  assert.equal(page.reloadCount, 0)
  finish()
  await flush()
})

test('售后刷新后真实观察器 pending 不能被页面已展示覆盖', async () => {
  const page = new ReloadPage()
  const capture = observePage(page)
  const flush = capture.flushResponses.bind(capture)
  capture.flushResponses = () => flush({ timeoutMs: 20, quietMs: 1 })
  let finish
  page.onReload = () => {
    finish = trackApiResponse(page, '/system/auth/get-permission-info',
      async () => '{"code":0,"data":{},"msg":""}')
  }
  await assert.rejects(reloadAfterSalesSettingsTab(page, '值班服务'),
    /响应检查未完成，禁止复用当前上下文.*system\/auth\/get-permission-info/)
  assert.equal(page.reloadCount, 1)
  assert.ok(page.events.includes('select-tab'))
  finish()
  await flush()
})

test('售后刷新响应体读取失败仍保留在共享观察器的失败证据中', async () => {
  const page = new ReloadPage()
  const record = { failedApiResponses: [] }
  observePage(page, record)
  page.onReload = () => {
    const finish = trackApiResponse(page, '/system/auth/get-permission-info', async () => {
      throw new Error('response body unavailable')
    })
    setImmediate(finish)
  }
  await reloadAfterSalesSettingsTab(page, '值班服务')
  assert.equal(record.failedApiResponses.length, 1)
  assert.equal(record.failedApiResponses[0].responseError, true)
  assert.match(record.failedApiResponses[0].error, /response body unavailable/)
})

test('售后页面清理只移除售后局部存储，不触碰认证会话', () => {
  assert.deepEqual(
    pageStorageKeysForAfterSales([
      'after-sales.active-tab',
      'aftersales-draft',
      'accessToken',
      'tenant-id',
      'theme'
    ]),
    ['after-sales.active-tab', 'aftersales-draft']
  )
})

test('PB130 页面证据必须同时包含人员、日期、电话和转接规则', () => {
  const expected = {
    dutyRole: 'E2E_DUTY_ROLE-X',
    employeeName: 'E2E 员工',
    date: '2026-10-12',
    phone: '400-900-1234',
    serviceScope: 'E2E 服务范围',
    startTime: '09:00',
    endTime: '18:00',
    nonServiceTip: '非服务时段请留言',
    timeoutMinutes: 5
  }
  assert.equal(assertDutyPagePersistence(
    `值班转接规则 ${Object.values(expected).join(' ')} 5 分钟后转备班角色`, expected
  ), true)
  assert.throws(
    () => assertDutyPagePersistence('值班转接规则 暂无 HRM/OA 排班数据', expected),
    /页面真实内容不完整/
  )
  assert.equal(assertDutyRosterRow(`${Object.values(expected).join(' ')} 人工`, expected), true)
  assert.throws(
    () => assertDutyRosterRow('E2E_DUTY_ROLE-X 其他员工 2026-10-12 400-900-1234 人工', expected),
    /专属 HRM 排班行页面真实内容不完整/
  )
})

test('PB125 保存请求不能使用旧关系、错资产或精度丢失的 ID', () => {
  const expected = {
    customerId: '2109264816687083522', assetId: '2109264816687083523',
    assetNo: 'PB125_ASSET-X', contactId: '2109264816687083524',
    managerName: '页面责任人', managerMobile: '13800000126',
    servicePeriod: { startDate: '2026-10-11', endDate: '2027-11-15',
      sourceNo: 'PB125_PAGE_SERVICE-X', sourceName: '页面服务依据' }
  }
  const payload = {
    customerId: expected.customerId,
    assets: [{ id: expected.assetId, assetNo: expected.assetNo,
      contactIds: [expected.contactId],
      managers: [{ managerName: expected.managerName, managerMobile: expected.managerMobile }],
      newServicePeriods: [{ ...expected.servicePeriod, sourceType: 'MANUAL' }] }]
  }
  assert.doesNotThrow(() => assertAssetProfileWrite(payload, expected))
  for (const change of [
    { id: '99' }, { id: Number(expected.assetId) },
    { contactIds: ['99'] }, { contactIds: [Number(expected.contactId)] },
    { managers: [{ managerName: '旧责任人', managerMobile: expected.managerMobile }] },
    { newServicePeriods: [] }, { newServicePeriods: [{ ...expected.servicePeriod, sourceType: 'CRM_CONTRACT' }] }
  ]) {
    assert.throws(() => assertAssetProfileWrite({
      ...payload, assets: [{ ...payload.assets[0], ...change }]
    }, expected))
  }
})

test('PB120 分类请求保持父级 ID 与三个适用字段，PB130 不能保存到共享规则', () => {
  const expected = {
    categoryId: '2109264816687083522', parentId: '2109264816687083523',
    categoryCode: 'E2E-X', persistedName: '页面分类',
    productType: 'STANDARD', assetType: 'SOFTWARE', serviceStatus: 'IN_SERVICE'
  }
  const response = { url: () => `http://127.0.0.1:48083/admin-api/after-sales/modeling/category/update?id=${expected.categoryId}` }
  const payload = {
    categoryCode: expected.categoryCode, categoryName: expected.persistedName,
    parentId: expected.parentId, applicableProductType: expected.productType,
    applicableAssetType: expected.assetType, applicableServiceStatus: expected.serviceStatus
  }
  assert.doesNotThrow(() => assertIssueCategoryWrite(response, payload, expected))
  assert.throws(() => assertIssueCategoryWrite(response,
    { ...payload, parentId: Number(expected.parentId) }, expected))
  assert.throws(() => assertIssueCategoryWrite(response,
    { ...payload, applicableAssetType: '' }, expected))
  const duty = { ruleId: expected.categoryId, dutyRole: 'E2E-ROLE',
    name: '页面规则', phone: '400-900-1257', serviceScope: '独立范围',
    timeoutMinutes: 7, transferOrder: 2, nonServiceTip: '独立提示' }
  const rule = { ...duty, id: duty.ruleId, enabled: true }
  assert.doesNotThrow(() => assertDutyRuleWrite(rule, duty))
  assert.throws(() => assertDutyRuleWrite({ ...rule, id: '99' }, duty))
  assert.throws(() => assertDutyRuleWrite({ ...rule, phone: '旧电话' }, duty))
})
