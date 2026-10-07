import { createApiClient } from '../lib/api.mjs'
import { config } from '../config/index.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['ERP-ACCOUNT-001']

export const WRITE_FIXTURE_ENV = 'CFOR_E2E_WRITE_FIXTURES'
export const ACCOUNT_REFERENCE_COLUMNS = Object.freeze([
  ['crm_receivable', 'bank_account_id'],
  ['erp_finance_payment', 'account_id'],
  ['erp_finance_receipt', 'account_id'],
  ['erp_purchase_in', 'account_id'],
  ['erp_purchase_order', 'account_id'],
  ['erp_purchase_return', 'account_id'],
  ['erp_sale_order', 'account_id'],
  ['erp_sale_out', 'account_id'],
  ['erp_sale_return', 'account_id'],
  ['fin_payable_check_entry', 'bank_account_id'],
  ['fin_payment', 'bank_account_id'],
  ['fin_payment_entry', 'bank_account_id'],
  ['fin_receipt', 'bank_account_id'],
  ['fin_receipt_entry', 'bank_account_id'],
  ['fin_receivable_check_entry', 'bank_account_id']
])

export const isWriteFixturesEnabled = (env = process.env) =>
  String(env[WRITE_FIXTURE_ENV] || '').trim().toLowerCase() === 'true'

export const isStableAccountId = (value) =>
  (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
  (typeof value === 'string' &&
    /^[1-9]\d{0,18}$/.test(value.trim()) &&
    BigInt(value) <= 9223372036854775807n)

export const dataOf = (response) => {
  if (
    response &&
    typeof response === 'object' &&
    Object.prototype.hasOwnProperty.call(response, 'data') &&
    ('code' in response || 'msg' in response || 'success' in response)
  ) {
    return response.data
  }
  return response
}

export const maskAccountNo = (value) => {
  if (value === undefined || value === null || value === '') return value
  const text = String(value)
  return text.length <= 4 ? '****' : `****${text.slice(-4)}`
}

export const isExpectedAccountRejection = (response, expectedMessage) =>
  response?.code !== undefined &&
  response.code !== 0 &&
  response.code !== 500 &&
  String(response?.msg || response?.message || '').includes(expectedMessage)

export const assertLocalAccountWriteTarget = ({
  target,
  webBase,
  apiBase,
  tenantId,
  tenantName
} = {}) => {
  if (target !== 'local') throw new Error('BLOCKED: ERP-ACCOUNT-001 写侧仅允许 local 目标')
  const web = new URL(webBase)
  const api = new URL(apiBase)
  const loopback = new Set(['127.0.0.1', 'localhost', '[::1]'])
  if (!loopback.has(web.hostname) || web.port !== '9151') {
    throw new Error(`BLOCKED: ERP-ACCOUNT-001 前端必须是 loopback:9151，当前=${webBase}`)
  }
  if (!loopback.has(api.hostname) || api.port !== '48083') {
    throw new Error(`BLOCKED: ERP-ACCOUNT-001 后端必须是 loopback:48083，当前=${apiBase}`)
  }
  if (String(tenantId) !== '1' || tenantName !== 'CFOR 标准平台') {
    throw new Error('BLOCKED: ERP-ACCOUNT-001 写侧仅允许租户 1 / CFOR 标准平台')
  }
  return true
}

export const buildAccountReferenceSql = (accountId) => {
  if (!isStableAccountId(accountId)) {
    throw new Error(`无效的 ERP 账户 ID：${JSON.stringify(accountId)}`)
  }
  const id = String(accountId)
  return ACCOUNT_REFERENCE_COLUMNS
    .map(([table, column]) =>
      `SELECT '${table}.${column}', COUNT(*) FROM \`${table}\` WHERE \`${column}\` = '${id}'`
    )
    .join('; ')
}

export const accountReferenceCounts = (rows) =>
  rows.map(([reference, count]) => ({ reference, count: Number(count) }))

const unique = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${process.pid}`

const accountFixtureBody = () => {
  const suffix = unique('A001')
  const accountNo = `9999${String(Date.now()).slice(-15)}`
  return {
    name: `E2E ERP资金账户 ${suffix}`,
    no: `E2E-ERP-A001-${suffix}`,
    accountType: 'BANK',
    accountNo,
    currency: 'CNY',
    status: 0,
    sort: 999,
    openingBank: 'E2E 测试银行',
    ownerName: 'CFOR E2E',
    purpose: 'E2E fixture only',
    remark: `CFOR-E2E:ERP-ACCOUNT-001:${suffix}`
  }
}

const requiredWritePermissions = [
  'erp:account:query',
  'erp:account:create',
  'erp:account:delete',
  'erp:account:sensitive-query'
]

const addCheck = (caseRecord, name, passed, details = '') => {
  caseRecord.checks.push({ name, passed: Boolean(passed), details })
}

const cleanupAccountFixture = async ({ api, fixture, caseRecord }) => {
  if (!fixture?.id) return

  const detailResponse = await api.get(`/erp/account/get?id=${encodeURIComponent(fixture.id)}`)
  const detail = dataOf(detailResponse)
  const owned =
    String(detail?.id) === String(fixture.id) &&
    detail?.no === fixture.no &&
    detail?.remark === fixture.remark
  if (!owned) {
    const message = `未确认自建账户所有权，禁止删除 id=${fixture.id}`
    caseRecord.notes.push(`未清理夹具：${message}`)
    addCheck(caseRecord, '仅清理本轮自建且未引用的账户夹具', false, message)
    return
  }

  const referenceResult = await runReadOnlySql(buildAccountReferenceSql(fixture.id))
  if (!referenceResult.available) {
    const message = `未取得账户引用只读证据：${referenceResult.reason}`
    caseRecord.notes.push(`未清理夹具 id=${fixture.id}：${message}`)
    addCheck(caseRecord, '仅清理本轮自建且未引用的账户夹具', false, message)
    return
  }
  const references = accountReferenceCounts(referenceResult.rows)
  caseRecord.database = [...(caseRecord.database || []), {
    stage: 'fixture-reference-check',
    accountId: fixture.id,
    references
  }]
  const used = references.filter((item) => item.count > 0)
  if (used.length) {
    const message = `账户已存在业务引用，禁止删除：${used.map((item) => `${item.reference}=${item.count}`).join(', ')}`
    caseRecord.notes.push(`未清理夹具 id=${fixture.id}：${message}`)
    addCheck(caseRecord, '仅清理本轮自建且未引用的账户夹具', false, message)
    return
  }

  const deleted = await api.deleteBusiness(`/erp/account/delete?id=${encodeURIComponent(fixture.id)}`)
  const deleteValue = dataOf(deleted)
  const afterDelete = await api.get(`/erp/account/get?id=${encodeURIComponent(fixture.id)}`)
  const detailReadbackPassed = afterDelete?.code === 0 && dataOf(afterDelete) == null
  addCheck(
    caseRecord,
    '删除后账户详情接口返回成功且不再有数据',
    detailReadbackPassed,
    `code=${afterDelete?.code ?? 'n/a'}, data=${dataOf(afterDelete) == null ? 'null' : 'present'}`
  )
  if (!detailReadbackPassed) {
    caseRecord.notes.push(
      `发现后端业务错误：删除后 GET /erp/account/get?id=${fixture.id} 返回 code=${afterDelete?.code ?? 'n/a'}`
    )
  }
  const pageAfterDelete = await api.get(
    `/erp/account/page?pageNo=1&pageSize=100&no=${encodeURIComponent(fixture.no)}`
  )
  const pageRows = Array.isArray(pageAfterDelete?.data?.list) ? pageAfterDelete.data.list : []
  const pageAbsent = pageAfterDelete?.code === 0 &&
    !pageRows.some((row) => String(row?.id) === String(fixture.id))
  const passed = deleteValue === true && pageAbsent
  addCheck(
    caseRecord,
    '仅清理本轮自建且未引用的账户夹具',
    passed,
    `id=${fixture.id}, deleted=${deleteValue}, pageAbsent=${pageAbsent}`
  )
  if (!passed) caseRecord.notes.push(`未清理夹具 id=${fixture.id}：删除响应或分页消失校验失败`)
}

const checkExpectedRejection = async (caseRecord, apiCall, label, message) => {
  let response
  try {
    response = await apiCall()
  } catch (error) {
    addCheck(caseRecord, label, false, `HTTP/transport rejection cannot prove domain rule: ${error.message}`)
    return false
  }
  const passed = isExpectedAccountRejection(response, message)
  addCheck(
    caseRecord,
    label,
    passed,
    `code=${response?.code ?? 'n/a'}, msg=${String(response?.msg || response?.message || '').slice(0, 160)}`
  )
  return passed
}

export const runCase = async ({ page, record, caseRecord, outputDir }) => {
  assertLocalAccountWriteTarget({
    target: config.target,
    webBase: config.webBase,
    apiBase: config.apiBase,
    tenantId: config.tenantId,
    tenantName: config.tenantName
  })
  addCheck(caseRecord, '写侧环境锁定为本地 9151/48083 与租户 1', true, 'CFOR 标准平台')

  const loginContext = await login(page, { returnContext: true })
  const token = loginContext.token
  const api = createApiClient({ token, record })
  const writeEnabled = isWriteFixturesEnabled()
  let fixture

  const permission = await api.getPermissionInfo()
  const permissions = permission?.data?.permissions || []
  const tenantMatches = String(loginContext.tenantId) === '1' && String(config.tenantId) === '1'
  addCheck(
    caseRecord,
    '真实 Chrome 登录上下文确认租户 1',
    tenantMatches,
    `tenantId=${loginContext.tenantId || 'unknown'}`
  )
  if (!tenantMatches) throw new Error('BLOCKED: 登录上下文未确认租户 1，停止 ERP 账户写侧')

  if (writeEnabled) {
    assertLocalAccountWriteTarget({
      target: config.target,
      webBase: config.webBase,
      apiBase: config.apiBase,
      tenantId: loginContext.tenantId,
      tenantName: config.tenantName
    })
    const unrestricted = permissions.includes('*:*:*')
    const missing = unrestricted
      ? []
      : requiredWritePermissions.filter((permissionKey) => !permissions.includes(permissionKey))
    if (missing.length) {
      throw new Error(`BLOCKED: 当前账号缺少 ERP 账户写侧权限：${missing.join(', ')}`)
    }
    addCheck(caseRecord, '写侧所需账户查询、创建、敏感查询和删除权限齐备', true, 'admin 权限上下文')
    await assertLocalWriteSafety(caseRecord)
  }

  try {
    const result = await api.get('/erp/account/page?pageNo=1&pageSize=100')
    const rows = Array.isArray(result?.data?.list) ? result.data.list : []
    const shapeValid = Array.isArray(result?.data?.list)
    const maskedRowsValid = rows.every(
      (row) =>
        row?.no &&
        row?.accountType !== undefined &&
        (!row?.accountNo || /^\*{4}\d{0,4}$/.test(row.accountNo))
    )
    addCheck(
      caseRecord,
      '企业资金账户分页返回主档字段且真实账号默认脱敏',
      shapeValid && (rows.length === 0 || maskedRowsValid),
      `rows=${rows.length}`
    )
    if (!rows.length) {
      caseRecord.notes.push('只读分页当前为空，未取得既有账户的字段/脱敏样本；不以空集判完整通过。')
    }

    if (writeEnabled) {
      fixture = accountFixtureBody()
      const created = await api.postBusiness('/erp/account/create', fixture)
      fixture.id = dataOf(created)
      if (!isStableAccountId(fixture.id)) {
        throw new Error(`创建接口返回无效账户 ID：${JSON.stringify(fixture.id)}`)
      }
      caseRecord.fixtures = [{
        kind: 'erp-account',
        id: fixture.id,
        no: fixture.no,
        tenantId: 1,
        accountNo: maskAccountNo(fixture.accountNo),
        cleanup: 'pending'
      }]
      addCheck(caseRecord, '显式 opt-in 后创建唯一 E2E 企业资金账户', true, `id=${fixture.id}, no=${fixture.no}`)

      const maskedDetail = dataOf(await api.getBusiness(
        `/erp/account/get?id=${encodeURIComponent(fixture.id)}`
      ))
      const sensitiveApi = createApiClient({ token })
      const sensitiveDetail = dataOf(await sensitiveApi.getBusiness(
        `/erp/account/get-sensitive?id=${encodeURIComponent(fixture.id)}`
      ))
      addCheck(
        caseRecord,
        '正式 API 回读账户主档字段、启用状态和默认脱敏',
        maskedDetail?.id &&
          String(maskedDetail.id) === String(fixture.id) &&
          maskedDetail.no === fixture.no &&
          maskedDetail.accountType === 'BANK' &&
          maskedDetail.currency === 'CNY' &&
          maskedDetail.status === 0 &&
          maskedDetail.defaultStatus !== true &&
          maskedDetail.accountNo === maskAccountNo(fixture.accountNo) &&
          maskedDetail.accountNo !== fixture.accountNo,
        `id=${maskedDetail?.id}, status=${maskedDetail?.status}, accountNo=${maskedDetail?.accountNo || 'empty'}`
      )
      addCheck(
        caseRecord,
        '敏感详情权限接口仅在显式敏感权限下回读完整账号',
        sensitiveDetail?.id &&
          String(sensitiveDetail.id) === String(fixture.id) &&
          sensitiveDetail.accountNo === fixture.accountNo,
        `id=${sensitiveDetail?.id}, fullAccountMatched=${sensitiveDetail?.accountNo === fixture.accountNo}`
      )

      const targetedPage = dataOf(await api.getBusiness(
        `/erp/account/page?pageNo=1&pageSize=100&no=${encodeURIComponent(fixture.no)}`
      ))
      const targetedRows = targetedPage?.list || []
      const targetedRow = targetedRows.find((row) => String(row?.id) === String(fixture.id))
      addCheck(
        caseRecord,
        '账户分页按唯一编码回读自建账户并保持脱敏',
        Boolean(targetedRow) &&
          targetedRow.no === fixture.no &&
          targetedRow.accountNo === maskAccountNo(fixture.accountNo) &&
          targetedRow.status === 0,
        `hits=${targetedRows.length}, accountNo=${targetedRow?.accountNo || 'missing'}`
      )

      const simpleList = dataOf(await api.getBusiness('/erp/account/simple-list'))
      addCheck(
        caseRecord,
        '启用状态账户进入精简列表且未改变默认账户设置',
        Array.isArray(simpleList) &&
          simpleList.some((item) => String(item?.id) === String(fixture.id)) &&
          simpleList.find((item) => String(item?.id) === String(fixture.id))?.defaultStatus !== true,
        `simpleListRows=${Array.isArray(simpleList) ? simpleList.length : 'invalid'}`
      )

      await checkExpectedRejection(
        caseRecord,
        () => api.post('/erp/account/create', {
          ...fixture,
          name: `${fixture.name} duplicate`,
          id: undefined
        }),
        '重复账户编码被正式 API 拒绝',
        '已存在编码'
      )
      await checkExpectedRejection(
        caseRecord,
        () => api.post('/erp/account/create', {
          ...fixture,
          id: undefined,
          no: `${fixture.no}-INVALID-RANGE`,
          effectiveFrom: '2026-10-10',
          effectiveTo: '2026-10-01'
        }),
        '生效日期晚于失效日期被正式 API 拒绝',
        '生效日期不能晚于失效日期'
      )
    }

    await openRoute(page, '/systemModel/base/account', { readyText: '账户编码' })
    const bodyText = await page.locator('body').innerText()
    addCheck(
      caseRecord,
      '企业资金账户设置页真实渲染',
      page.url().includes('/systemModel/base/account') &&
        bodyText.includes('账户编码') &&
        bodyText.includes('账户类型') &&
        bodyText.includes('真实账号'),
      page.url()
    )
    await saveScreenshot(page, outputDir, 'erp-account', record)
    caseRecord.evidence.push(
      writeEnabled
        ? '真实 Chrome 登录、唯一 E2E 账户创建、正式 API 回读、反例和引用保护清理'
        : '真实 Chrome 登录、账户分页脱敏契约和企业资金账户设置页截图'
    )
  } finally {
    if (writeEnabled && fixture?.id) {
      try {
        await cleanupAccountFixture({ api, fixture, caseRecord })
        if (caseRecord.fixtures?.[0]) {
          caseRecord.fixtures[0].cleanup =
            caseRecord.checks.at(-1)?.passed ? 'deleted' : 'not-cleaned'
        }
      } catch (error) {
        caseRecord.notes.push(`未清理夹具 id=${fixture.id}：${error.message}`)
        addCheck(caseRecord, '仅清理本轮自建且未引用的账户夹具', false, error.message)
      }
    }
  }

  const note = writeEnabled
    ? 'ERP-ACCOUNT-001 写侧夹具闭环已执行；更大范围 ERP/FMS 会计业务仍未验收，按目录保持 PARTIAL。'
    : '未开启 CFOR_E2E_WRITE_FIXTURES=true，仅执行原只读路径；空集或 HTTP 成功不代表完整业务通过。'
  return { token, api, partial: true, note }
}
