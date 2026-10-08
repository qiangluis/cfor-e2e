import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { config } from '../config/index.mjs'
import { apiHealth, createApiClient } from '../lib/api.mjs'
import { assertLocalDatabase, assertLocalWriteSafety } from '../lib/db.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['PB040-001', 'PB040-002', 'PB040-003']

const FIELD_PREFIX = 'E2E_PB040_'
const CUSTOM_FIELD_ROUTE = '/settings/business-settings/custom-field'
const RUNTIME_SCHEMA_PATH =
  '/system/custom-field/runtime-schema?businessObject=crm.customer&placement=FORM_HEADER'
const ERROR_CODE = {
  MISSING: 1002034000,
  CODE_IMMUTABLE: 1002034002,
  TYPE_IMMUTABLE: 1002034004,
  STATUS_INVALID: 1002034006
}

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

const isFieldId = (value) =>
  (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))) &&
  /^[1-9]\d*$/.test(String(value))

const fieldPath = (fieldId) => `/system/custom-field/get?id=${encodeURIComponent(fieldId)}`
const impactPath = (fieldId) => `/system/custom-field/impact?id=${encodeURIComponent(fieldId)}`

const recordFact = (caseRecord, name, passed, details = '') => {
  caseRecord.checks.push({ name, passed: Boolean(passed), details })
  if (!passed) throw new Error(`${name}: ${details}`)
}

export function initializeCatalogChecks (caseRecord, caseId) {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const definition = catalog.suites
    .flatMap((suite) => suite.cases)
    .find((item) => item.id === caseId)
  if (!cases.includes(caseId) || !definition?.assertions?.length) {
    throw new Error(`Missing PB040 catalog definition: ${caseId}`)
  }

  caseRecord.catalogChecks = definition.assertions.map((assertion, index) => ({
    index,
    assertion,
    status: 'GAP',
    evidenceChecks: [],
    details: '本轮尚未执行该原断言'
  }))
  // acceptance-gap-report reads this structured field. Keep catalogChecks as the
  // suite-facing name while emitting the compatible record for the shared report.
  caseRecord.catalogAssertions = caseRecord.catalogChecks
  caseRecord.notes.push(
    `catalog route=${definition.routes?.join(',') || 'n/a'}; actual page=${CUSTOM_FIELD_ROUTE}; 未修改目录`
  )
}

export function catalogCheck (caseRecord, index, evidenceChecks, gap = '') {
  const row = caseRecord.catalogChecks?.[index]
  if (!row || !Array.isArray(evidenceChecks) || evidenceChecks.length === 0) {
    throw new Error('Invalid PB040 catalog mapping')
  }
  const checks = evidenceChecks.map((name) =>
    caseRecord.checks.find((check) => check.name === name)
  )
  row.evidenceChecks = [...evidenceChecks]
  row.status = checks.some((check) => check?.passed === false)
    ? 'FAILED'
    : !gap && checks.every((check) => check?.passed === true)
        ? 'VERIFIED'
        : 'GAP'
  row.details = [
    gap,
    ...checks.map((check, position) =>
      check
        ? `${check.name}: ${check.details}`
        : `缺证: ${evidenceChecks[position]}`)
  ].filter(Boolean).join('; ')
}

export function catalogConclusion (caseRecord, extraGaps = []) {
  const rows = caseRecord.catalogChecks || []
  const remaining = [
    ...rows.filter((row) => row.status !== 'VERIFIED').map((row) => row.assertion),
    ...extraGaps
  ]
  caseRecord.remainingAssertions = [...new Set(remaining)]
  caseRecord.catalogComplete = rows.length > 0 &&
    rows.every((row) => row.status === 'VERIFIED')
  caseRecord.readyCandidate = caseRecord.catalogComplete &&
    extraGaps.length === 0 &&
    caseRecord.checks.length > 0 &&
    caseRecord.checks.every((check) => check.passed === true)

  return {
    partial: !caseRecord.readyCandidate,
    note: caseRecord.readyCandidate
      ? '本轮原断言均已逐条留证；catalog 保持 PARTIAL，READY 候选待主线程审查'
      : `GAP: ${caseRecord.remainingAssertions.join('；') || '存在失败断言'}`
  }
}

export function evaluateObjectPlacements (objects) {
  const allowed = new Set(['FORM_HEADER', 'FORM_BODY', 'DETAIL', 'API'])
  return Array.isArray(objects) &&
    objects.length > 0 &&
    new Set(objects.map((item) => item?.objectCode)).size === objects.length &&
    objects.every((item) =>
      item?.objectCode &&
      item?.moduleCode &&
      typeof item.headerSupported === 'boolean' &&
      typeof item.bodySupported === 'boolean' &&
      Array.isArray(item.supportedPlacements) &&
      item.supportedPlacements.length > 0 &&
      item.supportedPlacements.every((placement) => allowed.has(placement)) &&
      item.supportedPlacements.includes('FORM_HEADER') === item.headerSupported &&
      item.supportedPlacements.includes('FORM_BODY') === item.bodySupported
    )
}

export function evaluateRuntimeSnapshot (schema, definition, visible) {
  if (!Array.isArray(schema) || schema.length === 0 || !isFieldId(definition?.id)) return false
  const valid = schema.every((item) =>
    isFieldId(item?.id) &&
    item.status === 'PUBLISHED' &&
    Number(item.currentVersion) > 0 &&
    Array.isArray(item.bindings) &&
    item.bindings.length > 0 &&
    item.bindings.every((binding) =>
      binding.businessObject === 'crm.customer' &&
      binding.placement === 'FORM_HEADER'
    )
  )
  const matches = schema.filter((item) => String(item?.id) === String(definition.id))
  return valid && (
    visible
      ? definition.status === 'PUBLISHED' &&
        matches.length === 1 &&
        matches[0].fieldCode === definition.fieldCode &&
        matches[0].dataType === definition.dataType &&
        Number(matches[0].currentVersion) === Number(definition.currentVersion)
      : ['DRAFT', 'PENDING_PUBLISH', 'DISABLED'].includes(definition.status) &&
        matches.length === 0
  )
}

export function assertCustomFieldWriteScope (settings = config, auth, env = process.env) {
  if (
    env.CFOR_E2E_WRITE_FIXTURES !== 'true' ||
    settings.target !== 'local' ||
    String(settings.tenantId) !== '1' ||
    String(auth?.tenantId) !== '1' ||
    !auth?.token ||
    settings.tenantName !== 'CFOR 标准平台' ||
    settings.db?.name !== 'cfor_admin_standard'
  ) {
    throw new Error(
      'BLOCKED: PB040 fixtures require explicit opt-in and authenticated local tenant1/CFOR 标准平台'
    )
  }
  assertLocalDatabase(settings.db)
  for (const [base, port] of [[settings.webBase, '9151'], [settings.apiBase, '48083']]) {
    const url = new URL(base)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.port !== port ||
      url.username ||
      url.password
    ) {
      throw new Error('BLOCKED: PB040 fixtures require credential-free loopback 9151/48083')
    }
  }
}

export function assertOwnedCustomField (definition, fixture) {
  if (
    !fixture?.createdThisRun ||
    fixture.tenantId !== '1' ||
    !fixture.runId ||
    !isFieldId(fixture.fieldId) ||
    !fixture.fieldCode?.startsWith(FIELD_PREFIX) ||
    String(definition?.id) !== String(fixture.fieldId) ||
    definition?.fieldCode !== fixture.fieldCode ||
    definition?.description !== fixture.marker ||
    Number(definition?.referenceCount) !== 0
  ) {
    throw new Error('BLOCKED: custom-field fixture ownership/reference gate did not match')
  }
}

export const cleanupCustomField = async ({ api, fieldId, fixture, caseRecord }) => {
  if (!isFieldId(fieldId)) return false

  try {
    if (String(fieldId) !== String(fixture?.fieldId)) {
      throw new Error('BLOCKED: cleanup fixture ID mismatch')
    }
    let definition = dataOf(await api.getBusiness(fieldPath(fieldId)))
    const verifyOwnershipAndNoValues = async () => {
      assertOwnedCustomField(definition, fixture)
      const impact = dataOf(await api.getBusiness(impactPath(fieldId)))
      if (Number(impact?.valueCount) !== 0) {
        throw new Error('BLOCKED: fixture has business values or missing value-count evidence')
      }
    }

    await verifyOwnershipAndNoValues()
    if (definition.status === 'PENDING_PUBLISH') {
      await api.postBusiness('/system/custom-field/review-publish', {
        id: fieldId,
        decision: 'REJECT',
        opinion: `${fixture.marker} cleanup`
      })
      definition = dataOf(await api.getBusiness(fieldPath(fieldId)))
      await verifyOwnershipAndNoValues()
    }
    if (definition.status === 'PUBLISHED' || definition.status === 'DISABLED') {
      await api.postBusiness(`/system/custom-field/create-version?id=${encodeURIComponent(fieldId)}`)
      definition = dataOf(await api.getBusiness(fieldPath(fieldId)))
      await verifyOwnershipAndNoValues()
    }
    if (definition.status !== 'DRAFT') {
      throw new Error(`Cleanup status is not DRAFT: ${definition.status}`)
    }

    await api.deleteBusiness(`/system/custom-field/delete?id=${encodeURIComponent(fieldId)}`)
    const deleted = await api.get(fieldPath(fieldId))
    if (deleted?.code !== ERROR_CODE.MISSING) {
      throw new Error(`Cleanup readback code=${deleted?.code}`)
    }

    fixture.cleanup = 'DELETED_VERIFIED'
    caseRecord?.checks?.push({
      name: '本轮无业务值草稿正式删除并回读不存在',
      passed: true,
      details: `fieldId=${fieldId}; fieldCode=${fixture.fieldCode}; valueCount=0; code=${deleted.code}`
    })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (fixture) fixture.cleanup = 'NOT_CLEANED'
    caseRecord?.notes?.push(`PB040-002 清理失败 fieldId=${fieldId}: ${message}`)
    caseRecord?.checks?.push({
      name: '本轮无业务值草稿正式删除并回读不存在',
      passed: false,
      details: message
    })
    return false
  }
}

const openCustomFieldPage = (page) => openRoute(page, CUSTOM_FIELD_ROUTE, {
  readySelector: '.custom-field-tabs',
  readyTimeoutMs: 15000,
  retries: 1
})

const responseFor = (page, pathname, method) => page.waitForResponse(
  (response) =>
    new URL(response.url()).pathname.endsWith(pathname) &&
    response.request().method() === method,
  { timeout: 15000 }
)

const clickAndWait = async (page, locator, pathname, method = 'POST') => {
  const responsePromise = responseFor(page, pathname, method)
  await locator.click()
  await (await responsePromise).finished()
}

const visibleDialog = (page, title) =>
  page.locator('.el-dialog:visible').filter({ hasText: title }).first()

const labeledFormItem = (surface, label) =>
  surface.locator('.el-form-item').filter({ hasText: new RegExp(`^${label}`) }).first()

const findFixtureRow = async (page, fieldCode) => {
  await page.getByPlaceholder('请输入字段编码', { exact: true }).fill(fieldCode)
  await clickAndWait(
    page,
    page.getByRole('button', { name: '搜索', exact: true }),
    '/system/custom-field/page',
    'GET'
  )
  const rows = page.locator('.el-table__body tr').filter({ hasText: fieldCode })
  await rows.first().waitFor({ state: 'visible', timeout: 15000 })
  if (await rows.count() !== 1) {
    throw new Error(`Fixture row is not unique: ${fieldCode}`)
  }
  return rows.first()
}

const recordRuntimeSnapshot = async (api, caseRecord, fixture, definition, visible) => {
  const schema = dataOf(await api.getBusiness(RUNTIME_SCHEMA_PATH))
  const name = `专属 ${definition.status} 字段运行时 ${visible ? '可见' : '排除'}`
  const verified = evaluateRuntimeSnapshot(schema, definition, visible)
  // An empty schema is retained as evidence but cannot satisfy a runtime
  // assertion. It must not fail PB040-002 before the positive published proof.
  if (verified || schema?.length > 0) {
    recordFact(
      caseRecord,
      name,
      verified,
      `fieldId=${fixture.fieldId}; fieldCode=${fixture.fieldCode}; status=${definition.status}; schemaCount=${schema?.length}`
    )
  }
  fixture.runtime ||= []
  fixture.runtime.push({
    runId: fixture.runId,
    check: verified ? name : '',
    definition: {
      id: definition.id,
      fieldCode: definition.fieldCode,
      dataType: definition.dataType,
      status: definition.status,
      currentVersion: definition.currentVersion
    },
    schema,
    visible
  })
}

async function runDraftLifecycle ({ page, api, record, caseRecord, outputDir, auth }) {
  assertCustomFieldWriteScope(config, auth)
  await apiHealth()
  if (String(await api.tenantIdByName(config.tenantName)) !== '1') {
    throw new Error('BLOCKED: tenant name does not resolve to tenant1')
  }
  await assertLocalWriteSafety(caseRecord)

  const permissionInfo = dataOf(await api.getPermissionInfo())
  const requiredPermissions = ['query', 'create', 'update', 'publish', 'review']
    .map((value) => `system:custom-field:${value}`)
  const grantedPermissions = permissionInfo?.permissions
  if (
    !Array.isArray(grantedPermissions) ||
    !requiredPermissions.every((permission) => grantedPermissions.includes(permission))
  ) {
    throw new Error(
      `BLOCKED: missing PB040 fixture actor permissions: ${
        requiredPermissions.filter((permission) => !grantedPermissions?.includes(permission)).join(',')
      }`
    )
  }

  const fieldCode = `${FIELD_PREFIX}${Date.now()}_${randomBytes(3).toString('hex').toUpperCase()}`
  const fixture = {
    createdThisRun: true,
    tenantId: '1',
    runId: record.runId,
    fieldCode,
    marker: `${fieldCode} owned PB040-002`,
    cleanup: 'PENDING'
  }
  caseRecord.fixtures = [fixture]
  let cleaned = false

  try {
    fixture.fieldId = dataOf(await api.postBusiness('/system/custom-field/create', {
      fieldCode,
      fieldName: 'E2E 自定义项',
      dataType: 'TEXT',
      sensitivityLevel: 'NORMAL',
      description: fixture.marker,
      bindings: [{
        businessObject: 'crm.customer',
        placement: 'FORM_HEADER',
        displayOrder: 1,
        requiredOverride: false
      }]
    }))
    recordFact(
      caseRecord,
      '创建接口返回精确字段 ID',
      isFieldId(fixture.fieldId),
      `fieldId=${fixture.fieldId}; fieldCode=${fieldCode}`
    )

    let draft = dataOf(await api.getBusiness(fieldPath(fixture.fieldId)))
    assertOwnedCustomField(draft, fixture)
    recordFact(
      caseRecord,
      '草稿绑定正式回读',
      draft.status === 'DRAFT' &&
        draft.currentVersion === 0 &&
        draft.bindings?.length === 1 &&
        draft.bindings[0].businessObject === 'crm.customer' &&
        draft.bindings[0].placement === 'FORM_HEADER',
      `fieldId=${fixture.fieldId}; bindings=${JSON.stringify(draft.bindings)}`
    )
    catalogCheck(caseRecord, 0, ['创建接口返回精确字段 ID', '草稿绑定正式回读'])

    await openCustomFieldPage(page)
    let row = await findFixtureRow(page, fixture.fieldCode)
    await row.getByRole('button', { name: '编辑', exact: true }).click()
    const editDialog = visibleDialog(page, '编辑自定义项')
    await editDialog.waitFor({ state: 'visible' })

    const codeInput = labeledFormItem(editDialog, '字段编码').locator('input')
    const typeSelect = labeledFormItem(editDialog, '数据类型').locator('.el-select')
    await codeInput.waitFor({ state: 'visible' })
    const typeClass = await typeSelect.getAttribute('class') || ''
    recordFact(
      caseRecord,
      '草稿页面编码与类型控件可编辑',
      draft.codeEditable === true &&
        draft.dataTypeEditable === true &&
        await codeInput.isEnabled() &&
        !typeClass.includes('is-disabled'),
      `fieldId=${fixture.fieldId}; version=${draft.currentVersion}`
    )

    const editedCode = `${fieldCode}_EDIT`
    await codeInput.fill(editedCode)
    await typeSelect.click()
    await page.getByRole('option', { name: '整数', exact: true }).click()
    await clickAndWait(
      page,
      editDialog.getByRole('button', { name: '确定', exact: true }),
      '/system/custom-field/update',
      'PUT'
    )
    await editDialog.waitFor({ state: 'hidden' })
    draft = dataOf(await api.getBusiness(fieldPath(fixture.fieldId)))
    if (
      String(draft.id) === String(fixture.fieldId) &&
      draft.description === fixture.marker &&
      draft.fieldCode === editedCode
    ) {
      fixture.fieldCode = editedCode
    }
    assertOwnedCustomField(draft, fixture)
    recordFact(
      caseRecord,
      '草稿编码与类型实际修改后回读',
      draft.fieldCode === editedCode &&
        draft.dataType === 'INTEGER' &&
        draft.status === 'DRAFT' &&
        draft.currentVersion === 0 &&
        draft.codeEditable === true &&
        draft.dataTypeEditable === true,
      `fieldId=${fixture.fieldId}; fieldCode=${draft.fieldCode}; dataType=${draft.dataType}`
    )
    catalogCheck(caseRecord, 1, [
      '草稿页面编码与类型控件可编辑',
      '草稿编码与类型实际修改后回读'
    ])
    await saveScreenshot(page, outputDir, 'pb040-owned-edited-draft', record)
    await recordRuntimeSnapshot(api, caseRecord, fixture, draft, false)

    const impact = dataOf(await api.getBusiness(impactPath(fixture.fieldId)))
    recordFact(
      caseRecord,
      '发布影响预览无阻断与业务值',
      impact?.publishable === true &&
        impact.boundObjectCount === 1 &&
        Number(impact.valueCount) === 0 &&
        Array.isArray(impact.blockers) &&
        impact.blockers.length === 0,
      `fieldId=${fixture.fieldId}; impact=${JSON.stringify(impact)}`
    )

    row = await findFixtureRow(page, fixture.fieldCode)
    await clickAndWait(
      page,
      row.getByRole('button', { name: '提交发布', exact: true }),
      '/system/custom-field/submit-publish'
    )
    const pending = dataOf(await api.getBusiness(fieldPath(fixture.fieldId)))
    assertOwnedCustomField(pending, fixture)
    recordFact(
      caseRecord,
      '提交发布进入待审核并未递增版本',
      pending.status === 'PENDING_PUBLISH' && pending.currentVersion === 0,
      `fieldId=${fixture.fieldId}; status=${pending.status}; version=${pending.currentVersion}`
    )
    await recordRuntimeSnapshot(api, caseRecord, fixture, pending, false)

    row = await findFixtureRow(page, fixture.fieldCode)
    await row.getByRole('button', { name: '审核', exact: true }).click()
    const reviewDialog = visibleDialog(page, '自定义项发布审核')
    await reviewDialog.waitFor({ state: 'visible' })
    await labeledFormItem(reviewDialog, '审核意见').locator('textarea').fill(fixture.marker)
    await clickAndWait(
      page,
      reviewDialog.getByRole('button', { name: '确定', exact: true }),
      '/system/custom-field/review-publish'
    )
    await reviewDialog.waitFor({ state: 'hidden' })
    const published = dataOf(await api.getBusiness(fieldPath(fixture.fieldId)))
    assertOwnedCustomField(published, fixture)
    recordFact(
      caseRecord,
      '审核发布正式回读版本与锁定',
      published.status === 'PUBLISHED' &&
        published.currentVersion === 1 &&
        published.codeEditable === false &&
        published.dataTypeEditable === false,
      `fieldId=${fixture.fieldId}; status=${published.status}; version=${published.currentVersion}`
    )
    catalogCheck(caseRecord, 2, [
      '提交发布进入待审核并未递增版本',
      '审核发布正式回读版本与锁定'
    ])

    row = await findFixtureRow(page, fixture.fieldCode)
    recordFact(
      caseRecord,
      '发布后页面状态与操作一致',
      (await row.innerText()).includes('已发布') &&
        await row.getByRole('button', { name: '编辑', exact: true }).count() === 0 &&
        await row.getByRole('button', { name: '新版本', exact: true }).count() === 1,
      `fieldId=${fixture.fieldId}`
    )
    await saveScreenshot(page, outputDir, 'pb040-owned-published', record)
    await recordRuntimeSnapshot(api, caseRecord, fixture, published, true)

    const immutableAttempt = await api.put('/system/custom-field/update', {
      ...published,
      fieldCode: `${fixture.fieldCode}_CHANGED`
    })
    const unchanged = dataOf(await api.getBusiness(fieldPath(fixture.fieldId)))
    recordFact(
      caseRecord,
      '发布后直接改编码被状态门禁拒绝且原字段不变',
      immutableAttempt?.code === ERROR_CODE.STATUS_INVALID &&
        unchanged.fieldCode === fixture.fieldCode &&
        unchanged.dataType === published.dataType &&
        unchanged.status === 'PUBLISHED' &&
        unchanged.currentVersion === 1,
      `fieldId=${fixture.fieldId}; code=${immutableAttempt?.code}; msg=${immutableAttempt?.msg}; fieldCode=${unchanged.fieldCode}`
    )
    catalogCheck(caseRecord, 3, ['发布后直接改编码被状态门禁拒绝且原字段不变'])

    await clickAndWait(
      page,
      row.getByRole('button', { name: '停用', exact: true }),
      '/system/custom-field/disable'
    )
    const disabled = dataOf(await api.getBusiness(fieldPath(fixture.fieldId)))
    assertOwnedCustomField(disabled, fixture)
    recordFact(
      caseRecord,
      '专属字段停用正式回读',
      disabled.status === 'DISABLED' && disabled.currentVersion === 1,
      `fieldId=${fixture.fieldId}; status=${disabled.status}`
    )
    await recordRuntimeSnapshot(api, caseRecord, fixture, disabled, false)

    const beforeLogs = dataOf(await api.getBusiness(
      `/system/custom-field/publish-logs?id=${fixture.fieldId}`
    ))
    row = await findFixtureRow(page, fixture.fieldCode)
    await clickAndWait(
      page,
      row.getByRole('button', { name: '新版本', exact: true }),
      '/system/custom-field/create-version'
    )
    const nextDraft = dataOf(await api.getBusiness(fieldPath(fixture.fieldId)))
    assertOwnedCustomField(nextDraft, fixture)
    const logs = dataOf(await api.getBusiness(
      `/system/custom-field/publish-logs?id=${fixture.fieldId}`
    ))
    const transitions = [
      ['SUBMIT', 'DRAFT', 'PENDING_PUBLISH'],
      ['APPROVE', 'PENDING_PUBLISH', 'PUBLISHED'],
      ['DISABLE', 'PUBLISHED', 'DISABLED'],
      ['NEW_VERSION', 'DISABLED', 'DRAFT']
    ]
    recordFact(
      caseRecord,
      '新版本草稿保留精确发布日志',
      nextDraft.status === 'DRAFT' &&
        nextDraft.currentVersion === 1 &&
        nextDraft.codeEditable === false &&
        nextDraft.dataTypeEditable === false &&
        Array.isArray(beforeLogs) &&
        beforeLogs.length >= 3 &&
        Array.isArray(logs) &&
        beforeLogs.every((before) =>
          logs.some((after) => String(after.id) === String(before.id))
        ) &&
        transitions.every(([action, before, after]) =>
          logs.some((log) =>
            String(log.fieldId) === String(fixture.fieldId) &&
            log.action === action &&
            log.beforeStatus === before &&
            log.afterStatus === after &&
            isFieldId(log.operatorId)
          )
        ),
      `fieldId=${fixture.fieldId}; status=${nextDraft.status}; logs=${JSON.stringify(logs)}`
    )

    row = await findFixtureRow(page, fixture.fieldCode)
    await row.getByRole('button', { name: '日志', exact: true }).click()
    const drawer = page.locator('.el-drawer:visible').first()
    await drawer.waitFor({ state: 'visible' })
    await drawer.getByText('新建版本', { exact: true }).waitFor({ state: 'visible' })
    const logText = await drawer.innerText()
    recordFact(
      caseRecord,
      '真实页面新版本日志保留提交与审核',
      ['提交发布', '审核通过', '新建版本'].every((text) => logText.includes(text)),
      `fieldId=${fixture.fieldId}; drawer=发布日志`
    )
    await saveScreenshot(page, outputDir, 'pb040-owned-new-version-logs', record)
    await page.keyboard.press('Escape')
    catalogCheck(caseRecord, 4, [
      '新版本草稿保留精确发布日志',
      '真实页面新版本日志保留提交与审核'
    ])
    await recordRuntimeSnapshot(api, caseRecord, fixture, nextDraft, false)

    for (const [key, value, expectedCode] of [
      ['fieldCode', `${fixture.fieldCode}_CHANGED`, ERROR_CODE.CODE_IMMUTABLE],
      ['dataType', 'TEXT', ERROR_CODE.TYPE_IMMUTABLE]
    ]) {
      const rejected = await api.put('/system/custom-field/update', {
        ...nextDraft,
        [key]: value
      })
      const reread = dataOf(await api.getBusiness(fieldPath(fixture.fieldId)))
      recordFact(
        caseRecord,
        `新版本草稿 ${key} 精确不可变反例`,
        rejected?.code === expectedCode &&
          reread.fieldCode === fixture.fieldCode &&
          reread.dataType === 'INTEGER' &&
          reread.status === 'DRAFT',
        `fieldId=${fixture.fieldId}; code=${rejected?.code}; msg=${rejected?.msg}`
      )
    }
    caseRecord.evidence.push(
      `本轮 fieldId=${fixture.fieldId}; fieldCode=${fixture.fieldCode}; ` +
      '真实 Chrome 编辑/提交/审核/新版本/日志，正式 API 回读及精确业务拒绝；未写业务值'
    )
  } finally {
    cleaned = await cleanupCustomField({
      api,
      fieldId: fixture.fieldId,
      fixture,
      caseRecord
    })
  }

  return catalogConclusion(caseRecord, cleaned ? [] : ['专属夹具删除回读未完成'])
}

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  initializeCatalogChecks(caseRecord, caseId)
  const auth = await login(page, { returnContext: true })
  const token = auth.token
  const api = createApiClient({
    token,
    tenantId: auth.tenantId || config.tenantId,
    record
  })

  if (caseId === 'PB040-002') {
    if (process.env.CFOR_E2E_WRITE_FIXTURES !== 'true') {
      return {
        token,
        api,
        ...catalogConclusion(caseRecord, [
          '未启用 CFOR_E2E_WRITE_FIXTURES=true；没有创建或修改任何字段'
        ])
      }
    }
    return {
      token,
      api,
      ...await runDraftLifecycle({
        page,
        api,
        record,
        caseRecord,
        outputDir,
        auth
      })
    }
  }

  if (caseId === 'PB040-001') {
    const objects = dataOf(await api.getBusiness('/system/custom-field/object-catalog'))
    const definitions = dataOf(await api.getBusiness(
      '/system/custom-field/page?pageNo=1&pageSize=100'
    ))
    const requiredObjects = [
      'crm.customer',
      'erp.sale_order',
      'wms.stk_io',
      'pm.project',
      'after_sales.ticket'
    ]
    recordFact(
      caseRecord,
      '正式对象目录覆盖五域公共契约',
      Array.isArray(objects) &&
        objects.length > 0 &&
        requiredObjects.every((code) =>
          objects.some((object) => object.objectCode === code)
        ),
      `required=${requiredObjects.join(',')}; objectCount=${objects?.length}`
    )
    recordFact(
      caseRecord,
      '正式对象能力未开放未接线位置',
      evaluateObjectPlacements(objects),
      JSON.stringify(objects)
    )
    recordFact(
      caseRecord,
      '定义分页响应结构与计数有效',
      Array.isArray(definitions?.list) &&
        Number.isInteger(definitions.total) &&
        definitions.total >= definitions.list.length &&
        definitions.list.length <= 100 &&
        definitions.list.every((item) =>
          isFieldId(item?.id) && item.fieldCode && item.status
        ),
      `total=${definitions?.total}; count=${definitions?.list?.length}`
    )
    if (Array.isArray(definitions?.list) && definitions.list.length > 0) {
      recordFact(
        caseRecord,
        '定义分页含真实字段记录',
        true,
        `ids=${definitions.list.map((item) => item.id).join(',')}`
      )
    }

    await openCustomFieldPage(page)
    const definitionTab = page.getByRole('tab', {
      name: '自定义项定义',
      exact: true
    })
    const legacyTab = page.getByRole('tab', {
      name: '旧扩展槽位',
      exact: true
    })
    recordFact(
      caseRecord,
      '真实页面两个页签可见',
      await definitionTab.isVisible() && await legacyTab.isVisible(),
      page.url()
    )
    await legacyTab.click()
    await page.getByText('旧 custom_field1~20 只作兼容层', { exact: false })
      .waitFor({ state: 'visible' })
    await definitionTab.click()
    recordFact(
      caseRecord,
      '真实页面两个页签可切换',
      await definitionTab.getAttribute('aria-selected') === 'true',
      page.url()
    )
    await saveScreenshot(page, outputDir, 'pb040-custom-field-center', record)

    await page.getByRole('button', { name: '业务对象能力', exact: true }).click()
    const catalogDialog = visibleDialog(page, '已注册业务对象能力')
    await catalogDialog.waitFor({ state: 'visible' })
    for (const code of requiredObjects) {
      await catalogDialog.getByText(code, { exact: true }).waitFor({ state: 'visible' })
    }
    recordFact(
      caseRecord,
      '真实对象能力弹窗展示五域',
      requiredObjects.every((code) =>
        objects.some((object) => object.objectCode === code)
      ) &&
        requiredObjects.every((code) =>
          objects.find((object) => object.objectCode === code)?.supportedPlacements?.length > 0
        ) &&
        requiredObjects.every((code) =>
          objects.find((object) => object.objectCode === code)?.objectName
        ),
      `dialog=已注册业务对象能力; required=${requiredObjects.join(',')}`
    )
    await saveScreenshot(page, outputDir, 'pb040-object-capabilities', record)
    await catalogDialog.locator('.el-dialog__headerbtn').click()

    catalogCheck(caseRecord, 0, [
      '真实页面两个页签可见',
      '真实页面两个页签可切换'
    ])
    catalogCheck(caseRecord, 1, [
      '正式对象目录覆盖五域公共契约',
      '真实对象能力弹窗展示五域'
    ])
    catalogCheck(caseRecord, 2, ['正式对象能力未开放未接线位置'])
    catalogCheck(
      caseRecord,
      3,
      ['定义分页响应结构与计数有效', '定义分页含真实字段记录'],
      definitions?.list?.length
        ? ''
        : '定义分页为空；结构成功不能替代真实记录证据'
    )
    caseRecord.evidence.push(
      'PB040-001 只读 API、真实双页签切换与能力目录截图；未新增或停用定义'
    )
    return { token, api, ...catalogConclusion(caseRecord) }
  }

  const slots = dataOf(await api.getBusiness('/system/custom-field/legacy-slots'))
  recordFact(
    caseRecord,
    '旧槽位正式登记非空且结构有效',
    Array.isArray(slots) &&
      slots.length > 0 &&
      slots.every((slot) =>
        slot.tableName &&
        /^custom_field(?:[1-9]|1\d|20)$/.test(slot.columnName) &&
        slot.occupancyType &&
        slot.migrationStatus
      ),
    `slotCount=${slots?.length}`
  )
  const reserved = slots.filter((slot) => slot.occupancyType === 'SYSTEM_RESERVED')
  const unknown = slots.filter((slot) => slot.occupancyType === 'UNKNOWN')
  if (reserved.length > 0) {
    recordFact(
      caseRecord,
      '系统保留槽位有真实用途证据',
      reserved.every((slot) => Boolean(slot.systemPurpose)),
      `reserved=${reserved.length}; ids=${reserved.map((slot) => slot.id).join(',')}`
    )
  }
  if (unknown.length > 0) {
    recordFact(
      caseRecord,
      '未知槽位待人工审核且未映射暴露',
      unknown.every((slot) =>
        slot.migrationStatus === 'PENDING' && !slot.mappedFieldCode
      ),
      `unknown=${unknown.length}; pending=${
        unknown.filter((slot) => slot.migrationStatus === 'PENDING').length
      }`
    )
  }

  const runtimeSchema = dataOf(await api.getBusiness(RUNTIME_SCHEMA_PATH))
  recordFact(
    caseRecord,
    '当前运行时响应结构有效且没有非发布定义',
    Array.isArray(runtimeSchema) &&
      runtimeSchema.every((item) =>
        isFieldId(item?.id) &&
        item.status === 'PUBLISHED' &&
        Number(item.currentVersion) > 0
      ),
    `schemaCount=${runtimeSchema?.length}`
  )

  const lifecycleCase = record.cases?.find((item) => item.id === 'PB040-002')
  const fixture = lifecycleCase?.fixtures?.[0]
  const snapshots = fixture?.runtime || []
  const requiredStates = ['DRAFT', 'PENDING_PUBLISH', 'PUBLISHED', 'DISABLED']
  const hasLifecycleProof =
    fixture?.runId === record.runId &&
    fixture.createdThisRun === true &&
    requiredStates.every((status) =>
      snapshots.some((snapshot) =>
        snapshot.runId === record.runId &&
        snapshot.definition.status === status &&
        String(snapshot.definition.id) === String(fixture.fieldId) &&
        evaluateRuntimeSnapshot(
          snapshot.schema,
          snapshot.definition,
          status === 'PUBLISHED'
        ) &&
        lifecycleCase.checks.some((check) =>
          check.name === snapshot.check && check.passed === true
        )
      )
    )
  if (hasLifecycleProof) {
    recordFact(
      caseRecord,
      '本轮运行时有非空发布正例和草稿待审停用反例',
      true,
      `source=PB040-002; runId=${record.runId}; fieldId=${fixture.fieldId}; ` +
      `states=${requiredStates.join(',')}; cleanup=${fixture.cleanup}`
    )
  }

  await openCustomFieldPage(page)
  await page.getByRole('tab', { name: '旧扩展槽位', exact: true }).click()
  const legacyPanel = page.locator('.el-tab-pane').filter({
    hasText: '旧 custom_field1~20 只作兼容层'
  }).first()
  await legacyPanel.waitFor({ state: 'visible' })
  const hint = await legacyPanel.innerText()
  recordFact(
    caseRecord,
    '旧槽位真实页面兼容与人工审核提示',
    hint.includes('系统内部占用禁止租户覆盖') &&
      hint.includes('UNKNOWN 需人工审核'),
    page.url()
  )

  await labeledFormItem(legacyPanel, '占用类型').locator('.el-select').click()
  await page.getByRole('option', { name: '待人工审核', exact: true }).click()
  await clickAndWait(
    page,
    legacyPanel.getByRole('button', { name: '查询', exact: true }),
    '/system/custom-field/legacy-slots',
    'GET'
  )
  if (unknown.length > 0) {
    await legacyPanel.getByText('待人工审核', { exact: true }).last()
      .waitFor({ state: 'visible' })
    recordFact(
      caseRecord,
      '未知槽位人工审核筛选可见',
      true,
      `unknown=${unknown.length}; URL=${page.url()}`
    )
  }
  const reviewEntryCount = await legacyPanel.getByRole('button', {
    name: /审核|迁移/
  }).count()
  await saveScreenshot(page, outputDir, 'pb040-legacy-slots-unknown', record)

  catalogCheck(caseRecord, 0, ['旧槽位正式登记非空且结构有效'])
  catalogCheck(
    caseRecord,
    1,
    ['系统保留槽位有真实用途证据'],
    reserved.length ? '' : '缺 SYSTEM_RESERVED 实际样本'
  )
  catalogCheck(
    caseRecord,
    2,
    [
      '未知槽位待人工审核且未映射暴露',
      '旧槽位真实页面兼容与人工审核提示',
      '未知槽位人工审核筛选可见'
    ],
    !unknown.length
      ? '缺 UNKNOWN 实际样本'
      : !reviewEntryCount
          ? '仅有待人工审核筛选与提示，未发现可执行人工审核/迁移入口；不将提示冒充审核入口'
          : ''
  )
  catalogCheck(
    caseRecord,
    3,
    [
      '当前运行时响应结构有效且没有非发布定义',
      '本轮运行时有非空发布正例和草稿待审停用反例'
    ],
    hasLifecycleProof
      ? ''
      : '只读当前 Schema 不足以证明发布可见与停用排除；需同轮 PB040-002 生命周期证据'
  )
  caseRecord.evidence.push(
    'PB040-003 只读旧槽位与当前 Schema；同轮专属生命周期证据只作引用，未迁移或删除共享槽位'
  )
  return { token, api, ...catalogConclusion(caseRecord) }
}
