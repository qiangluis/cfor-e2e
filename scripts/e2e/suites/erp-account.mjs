import path from 'node:path'
import { createApiClient, isBusinessRejection } from '../lib/api.mjs'
import { config } from '../config/index.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { login, openRoute, saveScreenshot, waitForPageReady } from '../lib/browser.mjs'
import { decryptResponse, ENCRYPT_HEADER } from '../lib/crypto.mjs'

export const cases = ['ERP-ACCOUNT-001']

export const ACCOUNT_CATALOG_ASSERTIONS = Object.freeze([
  '账户编码、账户类型和有效期字段可见',
  '真实账号列表默认仅保留后四位'
])
// The formal list renders both dates in one column, not two date headers.
export const ACCOUNT_SETTING_HEADERS = Object.freeze([
  '账户编码', '账户类型', '真实账号', '有效期'
])
const acceptanceCheckNames = Object.freeze([
  [
    '账户分页按唯一编码回读自建账户并保持脱敏',
    '企业资金账户设置页真实列头包含账户编码、账户类型和有效期',
    '设置页按专属编码显示账户类型与有效期'
  ],
  [
    '正式 API 回读账户主档字段、启用状态和默认脱敏',
    '敏感详情权限接口仅在显式敏感权限下回读完整账号',
    '账户分页按唯一编码回读自建账户并保持脱敏',
    '设置页自建账户真实账号默认脱敏且完整号不出现'
  ]
])
export const ACCOUNT_REQUIRED_CHECKS = Object.freeze([
  '写侧环境锁定为本地 9151/48083 与租户 1',
  '真实 Chrome 登录上下文确认租户 1',
  '写侧所需账户查询、创建、敏感查询和删除权限齐备',
  '显式 opt-in 后创建唯一 E2E 企业资金账户',
  ...new Set(acceptanceCheckNames.flat()),
  '设置页按专属编码请求正式分页且业务成功',
  '启用状态账户进入精简列表且未改变默认账户设置',
  '重复账户编码被正式 API 拒绝',
  '生效日期晚于失效日期被正式 API 拒绝',
  '删除后账户详情接口返回成功且不再有数据',
  '仅清理本轮自建且未引用的账户夹具'
])

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
  isBusinessRejection(response) &&
  String(response?.msg || response?.message || '').includes(expectedMessage)

// Do not rely on the shared redactor for accountNo, including error payloads.
export const createAccountApiClient = ({ token, record } = {}) => {
  let lastEntry
  const client = createApiClient({
    token,
    record: {
      api: {
        push (entry) {
          lastEntry = entry
          record?.api?.push({ ...entry, bodySummary: '[ACCOUNT RESPONSE OMITTED]' })
        }
      }
    }
  })
  return Object.fromEntries(Object.entries(client).map(([name, method]) => [
    name,
    async (...args) => {
      lastEntry = undefined
      try {
        return await method.apply(client, args)
      } catch {
        throw new Error(
          `ERP account ${name} failure: HTTP=${lastEntry?.status ?? 'transport'}, ` +
          `code=${lastEntry?.code ?? 'n/a'}`
        )
      }
    }
  ]))
}

const normalizedText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
const hasAccountSample = (fixture) =>
  isStableAccountId(fixture?.id) &&
  typeof fixture?.no === 'string' && fixture.no.length > 0 &&
  typeof fixture?.accountNo === 'string' && /^\d{5,}$/.test(fixture.accountNo) &&
  /^\d{4}-\d{2}-\d{2}$/.test(fixture?.effectiveFrom || '') &&
  /^\d{4}-\d{2}-\d{2}$/.test(fixture?.effectiveTo || '')

export const accountRowEvidence = (row, fixture) => ({
  sampleMatched: hasAccountSample(fixture) && String(row?.id) === String(fixture.id),
  codeMatched: row?.no === fixture?.no,
  typeMatched: row?.accountType === fixture?.accountType,
  validityMatched: row?.effectiveFrom === fixture?.effectiveFrom &&
    row?.effectiveTo === fixture?.effectiveTo,
  enabled: row?.status === 0,
  notDefault: row?.defaultStatus !== true,
  masked: hasAccountSample(fixture) && row?.accountNo === maskAccountNo(fixture.accountNo) &&
    row.accountNo !== fixture.accountNo,
  fullAccountAbsent: hasAccountSample(fixture) &&
    !JSON.stringify(row ?? null).includes(fixture.accountNo)
})

export const accountPageEvidence = (response, fixture) => {
  const data = dataOf(response)
  const rows = Array.isArray(data?.list) ? data.list : []
  return {
    businessSuccess: response?.code === 0 && response.success !== false,
    pageValid: Array.isArray(data?.list) && Number.isSafeInteger(data.total) && data.total >= 0,
    sampleCount: rows.length,
    uniqueSample: data?.total === 1 && rows.length === 1,
    ...accountRowEvidence(rows[0], fixture),
    fullAccountAbsent: hasAccountSample(fixture) &&
      !JSON.stringify(data ?? null).includes(fixture.accountNo)
  }
}

export const accountSettingEvidence = ({ url, headers = [], rows = [], bodyText = '' }, fixture) => {
  const column = (label) => headers.indexOf(label)
  const matchingRows = rows.filter((cells) => cells[column('账户编码')] === fixture?.no)
  const cells = matchingRows[0] || []
  const accountType = normalizedText(cells[column('账户类型')])
  return {
    routeMatched: new URL(url).pathname === '/systemModel/base/account',
    headersMatched: ACCOUNT_SETTING_HEADERS.every((label) =>
      headers.filter((header) => header === label).length === 1),
    sampleCount: matchingRows.length,
    uniqueSample: hasAccountSample(fixture) && rows.length === 1 && matchingRows.length === 1,
    codeMatched: hasAccountSample(fixture) && cells[column('账户编码')] === fixture.no,
    typeVisible: Boolean(accountType) && !['-', 'undefined', 'null'].includes(accountType),
    validityMatched: hasAccountSample(fixture) &&
      normalizedText(cells[column('有效期')]) === `${fixture.effectiveFrom} ~ ${fixture.effectiveTo}`,
    masked: hasAccountSample(fixture) &&
      normalizedText(cells[column('真实账号')]) === maskAccountNo(fixture.accountNo),
    fullAccountAbsent: hasAccountSample(fixture) &&
      !bodyText.includes(fixture.accountNo) &&
      !JSON.stringify(rows).includes(fixture.accountNo)
  }
}

const evidenceKeys = {
  '正式 API 回读账户主档字段、启用状态和默认脱敏': [
    'sampleMatched', 'codeMatched', 'typeMatched', 'validityMatched', 'enabled',
    'notDefault', 'masked', 'fullAccountAbsent', 'currencyMatched'
  ],
  '敏感详情权限接口仅在显式敏感权限下回读完整账号': ['sampleMatched', 'fullAccountMatched'],
  '账户分页按唯一编码回读自建账户并保持脱敏': [
    'businessSuccess', 'pageValid', 'uniqueSample', 'sampleMatched', 'codeMatched',
    'typeMatched', 'validityMatched', 'enabled', 'notDefault', 'masked', 'fullAccountAbsent'
  ],
  '企业资金账户设置页真实列头包含账户编码、账户类型和有效期': [
    'routeMatched', 'headersMatched'
  ],
  '设置页按专属编码显示账户类型与有效期': [
    'uniqueSample', 'codeMatched', 'typeVisible', 'validityMatched'
  ],
  '设置页自建账户真实账号默认脱敏且完整号不出现': [
    'uniqueSample', 'masked', 'fullAccountAbsent'
  ]
}
const evidencePassed = (name, evidence) =>
  evidenceKeys[name].every((key) => evidence?.[key] === true)

export const accountCatalogEvidence = (caseRecord, { writeEnabled = false, sampleObserved = false } = {}) => {
  const checks = Array.isArray(caseRecord.checks) ? caseRecord.checks : []
  const matches = (name) => checks.filter((check) => check.name === name)
  const missing = ACCOUNT_REQUIRED_CHECKS.filter((name) =>
    matches(name).length !== 1 || matches(name)[0].passed !== true)
  const uniqueChecks = new Set(checks.map((check) => check.name)).size === checks.length
  const closure = writeEnabled === true && sampleObserved === true && uniqueChecks &&
    missing.length === 0 && checks.every((check) => check.passed === true)
  caseRecord.catalogAssertions = ACCOUNT_CATALOG_ASSERTIONS.map((assertion, index) => {
    const names = acceptanceCheckNames[index]
    const verified = closure && names.every((name) =>
      evidencePassed(name, matches(name)[0]?.evidence))
    return {
      index,
      assertion,
      status: verified ? 'VERIFIED' : 'GAP',
      evidenceChecks: [...names],
      details: verified ? '本轮专属账户 API、真实表格与安全清理证据齐备'
        : `本轮证据未闭合：writeEnabled=${writeEnabled === true}, ` +
          `sampleObserved=${sampleObserved === true}, uniqueChecks=${uniqueChecks}, ` +
          `missingOrFailed=${missing.length}`
    }
  })
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((item) => item.status === 'GAP').map((item) => item.assertion)
  caseRecord.acceptanceComplete = closure && caseRecord.remainingAssertions.length === 0
  caseRecord.passCandidate = caseRecord.acceptanceComplete
  caseRecord.partial = !caseRecord.acceptanceComplete
  return caseRecord
}

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
    effectiveFrom: '2026-01-01',
    effectiveTo: '2099-12-31',
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

const addEvidenceCheck = (caseRecord, name, evidence) => {
  caseRecord.checks.push({
    name,
    passed: evidencePassed(name, evidence),
    evidence,
    details: JSON.stringify(evidence)
  })
}

export const withAccountPagePrivacy = async (page, action, { tracePath } = {}) => {
  const tracing = page.context().tracing
  if (!tracing?.stop || !tracing?.start) {
    throw new Error('BLOCKED: 账户页面检查必须能暂停敏感数据 trace')
  }
  if (tracePath) await tracing.stop({ path: tracePath })
  else await tracing.stop()
  try {
    return await action()
  } finally {
    // No screenshot or DOM snapshot may retain an unexpected unmasked response.
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' })
    await tracing.start({ screenshots: true, snapshots: true, sources: false })
  }
}

export const readAccountPageResponse = async (response) => {
  try {
    const text = await response.text()
    return response.headers()[ENCRYPT_HEADER.toLowerCase()] === 'true'
      ? decryptResponse(text) : JSON.parse(text)
  } catch {
    throw new Error(`账户设置页分页响应不可解析：HTTP=${response.status()}`)
  }
}

const inspectAccountSetting = async ({ page, fixture, caseRecord, outputDir, record }) =>
  withAccountPagePrivacy(page, async () => {
    await openRoute(page, '/systemModel/base/account', { readyText: '账户编码' })
    if (fixture?.id) {
      await page.getByPlaceholder('请输入账户编码', { exact: true }).fill(fixture.no)
      const [response] = await Promise.all([
        page.waitForResponse((response) => {
          const url = new URL(response.url())
          return url.pathname === '/admin-api/erp/account/page' &&
            url.searchParams.get('no') === fixture.no &&
            response.request().method() === 'GET'
        }),
        page.getByRole('button', { name: '搜索', exact: true }).click()
      ])
      const payload = await readAccountPageResponse(response)
      const evidence = accountPageEvidence(payload, fixture)
      addCheck(caseRecord, '设置页按专属编码请求正式分页且业务成功',
        response.ok() && evidence.businessSuccess && evidence.uniqueSample,
        `HTTP=${response.status()}, code=${payload?.code ?? 'n/a'}, rows=${evidence.sampleCount}`)
      if (!response.ok() || !evidence.businessSuccess) {
        throw new Error(`账户设置页分页失败：HTTP=${response.status()}, code=${payload?.code ?? 'n/a'}`)
      }
      await waitForPageReady(page)
    }
    const table = page.locator('.el-table').first()
    const headers = await table.locator('.el-table__header-wrapper th').allTextContents()
    const rows = await table.locator('.el-table__body-wrapper tr.el-table__row').evaluateAll((rows) =>
      rows.map((row) => [...row.querySelectorAll('td')].map((cell) =>
        String(cell.textContent || '').replace(/\s+/g, ' ').trim()
      ))
    )
    const evidence = accountSettingEvidence({
      url: page.url(),
      headers: headers.map(normalizedText),
      rows,
      bodyText: await page.locator('body').innerText()
    }, fixture)
    addEvidenceCheck(caseRecord,
      '企业资金账户设置页真实列头包含账户编码、账户类型和有效期', evidence)
    if (fixture?.id) {
      addEvidenceCheck(caseRecord, '设置页按专属编码显示账户类型与有效期', evidence)
      addEvidenceCheck(caseRecord, '设置页自建账户真实账号默认脱敏且完整号不出现', evidence)
      if (evidence.uniqueSample && evidence.masked && evidence.fullAccountAbsent) {
        await saveScreenshot(page, outputDir, 'erp-account', record)
      } else {
        caseRecord.notes.push('GAP: 页面样本或默认脱敏未通过，未保存可能含完整账号的截图。')
      }
    } else {
      caseRecord.notes.push('GAP: 无本轮专属账户，未以既有行或空表替代页面脱敏证据，未保存账户截图。')
    }
  }, { tracePath: path.resolve(outputDir, '..', 'trace', 'erp-account-before-private-page.zip') })

export const cleanupAccountFixture = async ({
  api, fixture, caseRecord, readReferences = runReadOnlySql
}) => {
  if (!fixture?.id) return

  const detailResponse = await api.get(`/erp/account/get?id=${encodeURIComponent(fixture.id)}`)
  const detail = dataOf(detailResponse)
  const owned =
    detailResponse?.code === 0 &&
    String(detail?.id) === String(fixture.id) &&
    detail?.no === fixture.no &&
    detail?.remark === fixture.remark
  if (!owned) {
    const message = `未确认自建账户所有权，禁止删除 id=${fixture.id}`
    caseRecord.notes.push(`未清理夹具：${message}`)
    addCheck(caseRecord, '仅清理本轮自建且未引用的账户夹具', false, message)
    return
  }

  const referenceResult = await readReferences(buildAccountReferenceSql(fixture.id))
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
  const completeReferences = references.length === ACCOUNT_REFERENCE_COLUMNS.length &&
    ACCOUNT_REFERENCE_COLUMNS.every(([table, column]) =>
      references.filter((item) => item.reference === `${table}.${column}`).length === 1) &&
    references.every((item) => Number.isSafeInteger(item.count) && item.count >= 0)
  if (!completeReferences) {
    const message = '引用证据缺失、重复或计数无效，禁止删除'
    caseRecord.notes.push(`未清理夹具 id=${fixture.id}：${message}`)
    addCheck(caseRecord, '仅清理本轮自建且未引用的账户夹具', false, message)
    return
  }
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
  const pageAbsent = pageAfterDelete?.code === 0 &&
    Array.isArray(pageAfterDelete?.data?.list) &&
    pageAfterDelete.data.list.length === 0 &&
    pageAfterDelete.data.total === 0
  const passed = deleteValue === true && pageAbsent
  addCheck(
    caseRecord,
    '仅清理本轮自建且未引用的账户夹具',
    passed,
    `id=${fixture.id}, deleted=${deleteValue}, pageAbsent=${pageAbsent}`
  )
  if (!passed) caseRecord.notes.push(`未清理夹具 id=${fixture.id}：删除响应或分页消失校验失败`)
}

export const checkExpectedAccountRejection = async (caseRecord, apiCall, label, message) => {
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
    `code=${response?.code ?? 'n/a'}, expectedDomainMessageMatched=${passed}`
  )
  return passed
}

export const runCase = async ({ page, record, caseRecord, outputDir }) => {
  accountCatalogEvidence(caseRecord)
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
  const api = createAccountApiClient({ token, record })
  const writeEnabled = isWriteFixturesEnabled()
  let fixture
  let sampleObserved = false

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
    if (writeEnabled) {
      fixture = accountFixtureBody()
      const created = await api.postBusiness('/erp/account/create', fixture)
      fixture.id = dataOf(created)
      if (!isStableAccountId(fixture.id)) {
        throw new Error('创建接口未返回可安全清理的账户 ID')
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
      const sensitiveDetail = dataOf(await api.getBusiness(
        `/erp/account/get-sensitive?id=${encodeURIComponent(fixture.id)}`
      ))
      addEvidenceCheck(
        caseRecord,
        '正式 API 回读账户主档字段、启用状态和默认脱敏',
        { ...accountRowEvidence(maskedDetail, fixture), currencyMatched: maskedDetail?.currency === 'CNY' }
      )
      addEvidenceCheck(
        caseRecord,
        '敏感详情权限接口仅在显式敏感权限下回读完整账号',
        {
          sampleMatched: String(sensitiveDetail?.id) === String(fixture.id),
          fullAccountMatched: sensitiveDetail?.accountNo === fixture.accountNo
        }
      )

      const targetedPage = await api.getBusiness(
        `/erp/account/page?pageNo=1&pageSize=100&no=${encodeURIComponent(fixture.no)}`
      )
      const pageEvidence = accountPageEvidence(targetedPage, fixture)
      sampleObserved = pageEvidence.uniqueSample && pageEvidence.sampleMatched && pageEvidence.codeMatched
      addEvidenceCheck(caseRecord, '账户分页按唯一编码回读自建账户并保持脱敏', pageEvidence)

      const simpleList = dataOf(await api.getBusiness('/erp/account/simple-list'))
      addCheck(
        caseRecord,
        '启用状态账户进入精简列表且未改变默认账户设置',
        Array.isArray(simpleList) &&
          simpleList.some((item) => String(item?.id) === String(fixture.id)) &&
          simpleList.find((item) => String(item?.id) === String(fixture.id))?.defaultStatus !== true,
        `simpleListRows=${Array.isArray(simpleList) ? simpleList.length : 'invalid'}`
      )

      await checkExpectedAccountRejection(
        caseRecord,
        () => api.post('/erp/account/create', {
          ...fixture,
          name: `${fixture.name} duplicate`,
          id: undefined
        }, { expectedBusinessRejection: {
          code: 1030600002,
          message: `已存在编码为【${fixture.no}】的结算账户`
        } }),
        '重复账户编码被正式 API 拒绝',
        '已存在编码'
      )
      await checkExpectedAccountRejection(
        caseRecord,
        () => api.post('/erp/account/create', {
          ...fixture,
          id: undefined,
          no: `${fixture.no}-INVALID-RANGE`,
          effectiveFrom: '2026-10-10',
          effectiveTo: '2026-10-01'
        }, { expectedBusinessRejection: {
          code: 1030600003,
          message: '结算账户生效日期不能晚于失效日期'
        } }),
        '生效日期晚于失效日期被正式 API 拒绝',
        '生效日期不能晚于失效日期'
      )
    } else {
      const result = await api.getBusiness('/erp/account/page?pageNo=1&pageSize=100')
      const rows = result?.data?.list
      const shapeValid = Array.isArray(rows)
      if (shapeValid && rows.length > 0) {
        addCheck(caseRecord, '只读账户分页非空样本默认脱敏',
          rows.every((row) => !row?.accountNo || /^\*{4}\d{0,4}$/.test(row.accountNo)),
          `rows=${rows.length}`)
      }
      caseRecord.notes.push('GAP: 未开启写旗；既有账户、空列表和 HTTP 成功不作为本轮专属证据。')
    }

    await inspectAccountSetting({ page, fixture, caseRecord, outputDir, record })
    caseRecord.evidence.push(
      writeEnabled
        ? '真实 Chrome 登录、唯一 E2E 账户创建、正式 API 回读、反例和引用保护清理'
        : '真实 Chrome 登录和设置页列头检查；无本轮专属样本，保留 GAP'
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
    accountCatalogEvidence(caseRecord, { writeEnabled, sampleObserved })
  }

  const note = caseRecord.acceptanceComplete
    ? 'ERP-ACCOUNT-001 两条原 catalog 断言取得本轮专属 API、页面、反例与清理证据。'
    : writeEnabled
      ? 'ERP-ACCOUNT-001 本轮证据未闭合，详见失败 checks 和 catalogAssertions GAP。'
      : '未开启 CFOR_E2E_WRITE_FIXTURES=true，仅执行原只读路径；空集或 HTTP 成功不代表完整业务通过。'
  return {
    token, api, partial: !caseRecord.acceptanceComplete,
    acceptanceComplete: caseRecord.acceptanceComplete, note
  }
}
