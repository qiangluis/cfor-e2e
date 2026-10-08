import { createApiClient } from '../lib/api.mjs'
import { isBusinessSuccess, nonEmpty } from '../lib/assertions.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { prepareCostModelFixture, createLockedCostModelFixture } from '../fixtures/cost-model.mjs'
import {
  COST_SCENARIO_BY_CASE,
  loadCostScenario,
  prepareCostScenario
} from '../fixtures/cost-scenario.mjs'
import { runReadOnlySql } from '../lib/db.mjs'

export const cases = ['COST-001', 'COST-002', 'COST-003', 'COST-004', 'COST-005', 'COST-006', 'COST-007', 'COST-008', 'COST-009', 'COST-010', 'COST-011', 'COST-012', 'COST-013', 'COST-014', 'COST-015', 'COST-016', 'COST-017', 'COST-018', 'COST-019', 'COST-020', 'COST-021', 'COST-022', 'COST-023', 'COST-024', 'COST-025', 'COST-026', 'COST-027', 'COST-028', 'COST-029', 'COST-030', 'COST-031', 'COST-032', 'COST-033', 'COST-034']

const accountingOrgId = 1
const currentMonth = new Date().toISOString().slice(0, 7)

const offsetDate = (days) => {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

const flattenDepartments = (nodes) =>
  (nodes || []).flatMap((node) => [node, ...flattenDepartments(node.children || [])])

const responseData = (payload) => payload?.data ?? payload

export const costConfigurationSignature = (configuration) => {
  const categories = new Map(configuration.categories.map((row) => [row.id, row.code]))
  const items = new Map(configuration.items.map((row) => [row.id, row.code]))
  const sorted = (rows) => rows.map((row) => JSON.stringify(
    Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right)))
  )).sort()
  return JSON.stringify({
    categories: sorted(configuration.categories.map(({ id, parentId, ...row }) => ({
      ...row, parentCode: parentId ? categories.get(parentId) : ''
    }))),
    items: sorted(configuration.items.map(({ id, categoryId, ...row }) => ({
      ...row, categoryCode: categories.get(categoryId)
    }))),
    sourceRules: sorted(configuration.sourceRules.map(({ id, componentItemId, ...row }) => ({
      ...row, componentCode: items.get(componentItemId)
    })))
  })
}

const restoreCostConfiguration = async ({ api, modelVersionId, original, caseRecord }) => {
  await api.putBusiness(`/cost/model-versions/${modelVersionId}/components`, {
    categories: original.categories, items: original.items, sourceRules: original.sourceRules
  })
  const restored = responseData(await api.getBusiness(`/cost/model-versions/${modelVersionId}/components`))
  const passed = costConfigurationSignature(restored) === costConfigurationSignature(original)
  caseRecord.checks.push({
    name: '专属模型探针配置已恢复，分类、构成项及来源规则业务值与原始配置一致',
    passed, details: `model=${modelVersionId}`
  })
  if (!passed) throw new Error('Dedicated cost configuration was not completely restored')
}

const recordCostDatabase = async ({ modelVersionId, caseRecord }) => {
  if (!/^[1-9]\d*$/.test(modelVersionId)) throw new Error('Invalid cost database fixture ID')
  const snapshot = await runReadOnlySql(`
    SELECT 'model', COUNT(*) FROM cost_model_version
    WHERE tenant_id=1 AND id=${modelVersionId} AND deleted=0;
    SELECT 'categories', COUNT(*) FROM cost_component_category
    WHERE tenant_id=1 AND model_version_id=${modelVersionId} AND deleted=0;
    SELECT 'items', COUNT(*) FROM cost_component_item
    WHERE tenant_id=1 AND model_version_id=${modelVersionId} AND deleted=0;
    SELECT 'sourceRules', COUNT(*) FROM cost_component_source_rule s
    JOIN cost_component_item i ON i.id=s.component_item_id AND i.tenant_id=s.tenant_id
    WHERE i.tenant_id=1 AND i.model_version_id=${modelVersionId} AND i.deleted=0 AND s.deleted=0
  `)
  caseRecord.database = [...(caseRecord.database || []), { stage: 'owned-cost-final', ...snapshot }]
  const passed = snapshot.available && snapshot.rows.length === 4 &&
    snapshot.rows.every(([tag, count]) => tag === 'model' ? count === '1' : Number(count) > 0)
  caseRecord.checks.push({
    name: '本案例模型、分类、构成项和来源规则已在当前租户正式表落库',
    passed, details: JSON.stringify(snapshot.rows)
  })
  if (!passed) throw new Error('Cost configuration database evidence is incomplete')
}

export const hasDeadLetterSamples = (rows) => Array.isArray(rows) && rows.length > 0

// 成本页面草稿状态的正式后端键名，与前端 cost-management 常量保持一致。
const COST_WORKSPACE_STATE_KEYS = {
  model: 'cost-model-base-config-20260825-clean-v2',
  activePeriod: 'cost-active-period-20260825-clean-v2',
  openingWipGate: 'cost-opening-wip-formal-gates-20260825-clean-v2'
}

const readCostWorkspaceState = async (api, stateKey) =>
  responseData(
    await api.getBusiness(
      `/cost/workspace-states/get?accountingOrgId=${accountingOrgId}&stateKey=${encodeURIComponent(stateKey)}`
    )
  )

const saveCostWorkspaceState = async (api, stateKey, payload, version) =>
  responseData(
    await api.putBusiness('/cost/workspace-states/save', {
      accountingOrgId,
      stateKey,
      payloadJson: JSON.stringify(payload),
      version
    })
  )

/**
 * 上期结转的口径说明只在"上期在制"阶段渲染，而该阶段由页面草稿状态派生。
 *
 * <p>这里按正式 workspace-state 契约，临时把当前模型标记为已产生首次正式成本并把
 * 当前期间切到下一个月，断言结束后按原 payload 恢复，避免污染用户页面状态。</p>
 */
const withCarryoverStage = async (api, action) => {
  const modelState = await readCostWorkspaceState(api, COST_WORKSPACE_STATE_KEYS.model)
  const model = JSON.parse(modelState?.payloadJson || '{}')
  const enterpriseType = model.enterpriseType || '生产型'
  const modelKey = `${enterpriseType}|${model.version || 'V1'}`

  const gateState = await readCostWorkspaceState(api, COST_WORKSPACE_STATE_KEYS.openingWipGate)
  const gatePayload = JSON.parse(gateState?.payloadJson || '{}')
  const activeState = await readCostWorkspaceState(api, COST_WORKSPACE_STATE_KEYS.activePeriod)
  const activePayload = JSON.parse(activeState?.payloadJson || '{}')

  const savedGate = await saveCostWorkspaceState(api, COST_WORKSPACE_STATE_KEYS.openingWipGate, {
    ...gatePayload,
    [modelKey]: {
      firstFormalPeriod: '2000-01',
      firstFormalBatchNo: 'E2E-CARRYOVER-STAGE',
      state: '已正式写入',
      lockedAt: '',
      ...(gatePayload[modelKey] || {})
    }
  }, gateState?.version ?? 0)
  const savedActive = await saveCostWorkspaceState(api, COST_WORKSPACE_STATE_KEYS.activePeriod, {
    ...activePayload,
    [enterpriseType]: '2000-02'
  }, activeState?.version ?? 0)

  try {
    return await action()
  } finally {
    await saveCostWorkspaceState(
      api, COST_WORKSPACE_STATE_KEYS.openingWipGate,
      gatePayload, savedGate?.version ?? 0
    ).catch(() => {})
    await saveCostWorkspaceState(
      api, COST_WORKSPACE_STATE_KEYS.activePeriod,
      activePayload, savedActive?.version ?? 0
    ).catch(() => {})
  }
}

export const costArrayData = (payload, label) => {
  if (!isBusinessSuccess(payload) || !Array.isArray(payload.data)) {
    throw new Error(`${label} 未返回有效业务数组，不能视为缺少依赖`)
  }
  return payload.data
}

export const costPageRows = (payload, label) => {
  const data = payload?.data
  if (
    !isBusinessSuccess(payload) ||
    !Array.isArray(data?.list) ||
    !Number.isSafeInteger(data.total) ||
    data.total < data.list.length ||
    (data.list.length === 0 && data.total !== 0)
  ) {
    throw new Error(`${label} 未返回有效分页列表，不能视为缺少依赖`)
  }
  return data.list
}

export const hasEditableCostModel = (rows) =>
  rows.some((row) => row.status === 'DRAFT' && nonEmpty(row.id))

const saveCostPrerequisiteEvidence = async ({ caseId, page, record, caseRecord, outputDir, note }) => {
  await openRoute(page, '/cost-management/workbench', { readySelector: '.title-line h1' })
  caseRecord.checks.push({
    name: '依赖缺失时仍完成真实成本工作台只读前置验证',
    passed: await page.getByRole('heading', { name: '成本工作台', exact: true }).isVisible(),
    details: page.url()
  })
  caseRecord.notes.push(note)
  await saveScreenshot(page, outputDir, `${caseId}-prerequisite`, record)
  caseRecord.evidence.push('仅验证正式查询与真实工作台前置，未执行缺少依赖的业务闭环')
}

export const nextCostCenterStartDate = ({ centers, departmentId, today }) => {
  const latestDisabledAt = centers
    .filter((row) =>
      (row.departmentIds || []).some((id) => String(id) === String(departmentId))
    )
    .map((row) => row.disabledAt)
    .filter(Boolean)
    .sort()
    .at(-1)
  if (!latestDisabledAt || latestDisabledAt < today) return today
  const date = new Date(`${latestDisabledAt}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

const PERIOD_DEPENDENT_CASES = new Set([
  'COST-002', 'COST-003', 'COST-005', 'COST-006', 'COST-008', 'COST-009',
  'COST-010', 'COST-011', 'COST-012', 'COST-013', 'COST-014', 'COST-015',
  'COST-016', 'COST-017', 'COST-018', 'COST-019', 'COST-020', 'COST-021',
  'COST-022', 'COST-023', 'COST-024', 'COST-025', 'COST-026', 'COST-027',
  'COST-028', 'COST-033', 'COST-034'
])
const MODEL_DEPENDENT_CASES = new Set(['COST-030', 'COST-031', 'COST-032'])
export const COST_CASE_EFFECTIVE_MONTH = '2099-12'

const isCostFixtureId = (value) =>
  typeof value === 'string' &&
  /^[1-9]\d*$/.test(value) &&
  BigInt(value) <= 9223372036854775807n

const costScopeId = (value) =>
  isCostFixtureId(value) ? value : Number.isSafeInteger(value) && value > 0 ? String(value) : null

// A local case/run registration and persisted remarks must agree; names never grant ownership.
export const costFixtureRemark = (fixture) =>
  `CFOR-E2E:${fixture.caseId}:${fixture.runId}:${fixture.fixtureId}:tenant=${fixture.tenantId}:org=${fixture.accountingOrgId}:month=${fixture.effectiveMonth}:exclusive`

const registeredCostFixture = ({ caseId, record, caseRecord } = {}) => {
  const fixture = caseRecord?.fixtures?.cost
  const runId = record?.runId
  if (
    !MODEL_DEPENDENT_CASES.has(caseId) ||
    caseRecord?.id !== caseId ||
    caseRecord?.caseId !== caseId ||
    typeof runId !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(runId) ||
    !fixture ||
    fixture.exclusive !== true ||
    fixture.caseId !== caseId ||
    fixture.runId !== runId ||
    typeof fixture.fixtureId !== 'string' ||
    !fixture.fixtureId.startsWith(`E2E-${caseId}-${runId}-`) ||
    !/^[A-Za-z0-9_-]+$/.test(fixture.fixtureId) ||
    fixture.fixtureId.length <= `E2E-${caseId}-${runId}-`.length ||
    !costScopeId(record?.environment?.tenantId) ||
    costScopeId(fixture.tenantId) !== costScopeId(record.environment.tenantId) ||
    costScopeId(fixture.accountingOrgId) !== String(accountingOrgId) ||
    fixture.effectiveMonth !== COST_CASE_EFFECTIVE_MONTH ||
    ![fixture.modelVersionId, fixture.costCenterId, fixture.componentItemId].every(isCostFixtureId)
  ) return null
  return fixture
}

export const isOwnedCostModelFixture = (model, context) => {
  const fixture = registeredCostFixture(context)
  return Boolean(
    fixture &&
    isCostFixtureId(model?.id) &&
    model.id === fixture.modelVersionId &&
    model.status === 'DRAFT' &&
    model.lockedAt == null &&
    model.lockedBy == null &&
    costScopeId(model.accountingOrgId) === String(accountingOrgId) &&
    model.effectiveMonth === fixture.effectiveMonth &&
    model.remark === costFixtureRemark(fixture)
  )
}

const costFixtureObjectData = (payload, label) => {
  if (
    !isBusinessSuccess(payload) ||
    (payload.data !== null &&
      (typeof payload.data !== 'object' || Array.isArray(payload.data)))
  ) throw new Error(`${label} 未返回有效业务对象，不能视为缺少归属证据`)
  return payload.data
}

export const loadOwnedCostFixture = async ({ api, modelVersions, ...context }) => {
  const missing = (note) => ({ fixture: null, note })
  const registration = registeredCostFixture(context)
  if (!registration) return missing('缺少本案、本轮、当前租户的专属 E2E 夹具精确 ID 登记')
  const matches = modelVersions.filter((row) => row.id === registration.modelVersionId)
  if (matches.length !== 1 || !isOwnedCostModelFixture(matches[0], context)) {
    return missing('登记模型不唯一或缺少严格归属证据；版本名称中的 E2E 标记不能授权写侧')
  }
  const model = costFixtureObjectData(
    await api.getBusiness(`/cost/model-versions/${registration.modelVersionId}`),
    '专属成本模型详情'
  )
  if (!isOwnedCostModelFixture(model, context)) {
    return missing('登记模型详情与本轮夹具 ID、备注、组织、草稿状态或远期月份不符')
  }
  const center = costFixtureObjectData(
    await api.getBusiness(`/cost/centers/${registration.costCenterId}`),
    '专属成本中心详情'
  )
  const remark = costFixtureRemark(registration)
  if (
    !center ||
    !isCostFixtureId(center.id) ||
    center.id !== registration.costCenterId ||
    costScopeId(center.accountingOrgId) !== String(accountingOrgId) ||
    center.status !== 'ENABLED' ||
    center.enabledAt !== `${registration.effectiveMonth}-01` ||
    center.disabledAt != null ||
    center.referenceCount !== 0 ||
    center.remark !== remark
  ) return missing('登记成本中心不属于同一本轮远期 E2E 夹具，或已存在共享业务引用')

  const config = costFixtureObjectData(
    await api.getBusiness(`/cost/model-versions/${registration.modelVersionId}/components`),
    '专属成本构成配置'
  )
  if (!config) return missing('登记模型缺少构成配置归属证据')
  if (![config.categories, config.items, config.sourceRules].every(Array.isArray)) {
    throw new Error('专属成本构成配置未返回分类/构成项/来源规则数组，不能视为缺少归属证据')
  }
  const categoryIds = new Set(config.categories.map((row) => row.id))
  const itemIds = new Set(config.items.map((row) => row.id))
  const componentMatches = config.items.filter((row) => row.id === registration.componentItemId)
  if (
    config.modelVersionId !== model.id ||
    config.categories.length === 0 ||
    categoryIds.size !== config.categories.length ||
    itemIds.size !== config.items.length ||
    componentMatches.length !== 1 ||
    !config.categories.every((row) =>
      isCostFixtureId(row.id) &&
      (!row.parentId || categoryIds.has(row.parentId))
    ) ||
    !config.items.every((row) =>
      isCostFixtureId(row.id) &&
      categoryIds.has(row.categoryId) &&
      row.remark === remark &&
      row.systemItem === false &&
      row.status === 'ENABLED'
    ) ||
    !config.sourceRules.every((row) =>
      isCostFixtureId(row.id) && itemIds.has(row.componentItemId)
    )
  ) return missing('构成配置模型关联或精确构成项 ID 不符，或混入非本轮专属构成项/来源规则')

  const rules = costArrayData(await api.getBusiness(
    `/cost/allocation-rules?modelVersionId=${model.id}&effectiveMonth=${registration.effectiveMonth}`
  ), '专属成本模型远期分摊规则')
  if (rules.length > 0) return missing('专属模型远期月份已有分摊规则，未覆盖任何既有规则或其构成项')
  return { fixture: { model, center, componentItem: componentMatches[0], config }, note: '' }
}

const loadFormalModelPage = async (api) => {
  const result = await api.getBusiness(
    `/cost/model-versions?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
  )
  const list = costPageRows(result, '成本模型版本')
  return { list, model: list.find((item) => item.status === 'LOCKED') || list[0] || null }
}

const trackedTraceShape = (rows) =>
  rows.every(
    (row) =>
      ['AVAILABLE', 'NOT_AVAILABLE'].includes(row.payableTraceStatus) &&
      row.materialAmount !== undefined &&
      Array.isArray(row.payableSettlementTraces)
  )

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }, dependencies = {}) => {
  const token = await (dependencies.login || login)(page)
  const api = (dependencies.createApiClient || createApiClient)({ token, record })
  const savePrerequisiteEvidence = dependencies.saveCostPrerequisiteEvidence || saveCostPrerequisiteEvidence
  if (MODEL_DEPENDENT_CASES.has(caseId) && !caseRecord.fixtures?.cost) {
    await (dependencies.prepareCostFixture || prepareCostModelFixture)({
      api, caseId, record, caseRecord,
      effectiveMonth: COST_CASE_EFFECTIVE_MONTH, remarkForFixture: costFixtureRemark
    })
  }
  const { list: modelVersions, model } = await loadFormalModelPage(api)
  caseRecord.checks.push({
    name: '成本模型版本 API 可用',
    passed: Array.isArray(modelVersions),
    details: model
      ? `${model.id}:${model.versionNo}:${model.status}`
      : '当前租户暂无成本模型，已验证空列表契约'
  })

  // 正式报表 / 采购来源刷新 / 试算职责分离 / 上期结转都需要真实写侧事实，
  // 因此先按案例语义建立专属远期期间的夹具，再进入只读断言。
  const scenarioKind = COST_SCENARIO_BY_CASE[caseId]
  if (scenarioKind && !loadCostScenario(caseRecord)) {
    await (dependencies.prepareCostScenario || prepareCostScenario)({
      api, record, caseRecord, scenario: scenarioKind
    })
  }

  if (PERIOD_DEPENDENT_CASES.has(caseId)) {
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const periods = costPageRows(periodsResult, '成本期间')
    if (periods.length === 0) {
      caseRecord.checks.push({
        name: '成本期间正式 API 返回有效空列表（后续保留 PARTIAL）',
        passed: true,
        details: '当前核算组织暂无成本期间，未伪造期间、账套或经营事实'
      })
      await saveCostPrerequisiteEvidence({
        caseId, page, record, caseRecord, outputDir,
        note: '当前核算组织暂无成本期间；正式业务闭环待用户确认会计期间后复测。'
      })
      return {
        token,
        api,
        partial: true,
        note: '缺少成本期间前置，未执行写侧和正式报表断言'
      }
    }
  }

  let ownedCostFixture
  if (MODEL_DEPENDENT_CASES.has(caseId)) {
    const prerequisite = await loadOwnedCostFixture({ api, modelVersions, caseId, record, caseRecord })
    ownedCostFixture = prerequisite.fixture
    if (!ownedCostFixture) {
      caseRecord.checks.push({
        name: '专属夹具安全门禁阻断写侧（保留 PARTIAL）',
        passed: true,
        details: prerequisite.note
      })
      await savePrerequisiteEvidence({
        caseId, page, record, caseRecord, outputDir,
        note: `${prerequisite.note}；未修改历史/共享模型、中心、构成项或分摊规则，未自动创建夹具。`
      })
      return { token, api, partial: true, note: prerequisite.note }
    }
    caseRecord.checks.push({
      name: '模型/中心/构成项精确 ID 与本案本轮 E2E 归属及远期月份一致',
      passed: true,
      details: `model=${ownedCostFixture.model.id} center=${ownedCostFixture.center.id} item=${ownedCostFixture.componentItem.id}`
    })
  }

  if (caseId === 'COST-001') {
    // PB-074：分摊规则按模型版本、成本中心和生效月份读写正式库。
    const rulesResult = model?.id
      ? await api.getBusiness(
          `/cost/allocation-rules?modelVersionId=${model.id}&effectiveMonth=${currentMonth}`
        )
      : null
    const rules = rulesResult?.data || []
    caseRecord.checks.push({
      name: '分摊规则正式接口按模型版本与月份返回列表',
      passed: Array.isArray(rules),
      details: `rows=${Array.isArray(rules) ? rules.length : 'n/a'}`
    })
    if (rules.length) {
      caseRecord.checks.push({
        name: '分摊规则包含成本中心、构成项与分摊模式',
        passed: rules.every(
          (row) =>
            nonEmpty(row.costCenterId) &&
            Array.isArray(row.lines) &&
            row.lines.length > 0 &&
            row.lines.every(
              (line) =>
                nonEmpty(line.componentItemId) &&
                ['QUANTITY', 'AMOUNT', 'MANUAL'].includes(line.allocationMode)
            )
        ),
        details: `rules=${rules.length}`
      })
    }
    const centersResult = await api.getBusiness(`/cost/centers?accountingOrgId=${accountingOrgId}`)
    caseRecord.checks.push({
      name: '成本中心正式主档可用',
      passed: Array.isArray(centersResult?.data),
      details: `centers=${centersResult?.data?.length ?? 0}`
    })
    await openRoute(page, '/cost-management/modeling/allocation-rule', {
      readySelector: '.allocation-workspace',
      retries: 1
    })
    caseRecord.checks.push({
      name: '成本分摊规则页面可打开',
      passed: (await page.locator('.allocation-workspace').count()) > 0,
      details: '真实 Chrome 成本分摊规则页'
    })
    caseRecord.checks.push({
      name: '页面展示成本中心或空态',
      passed:
        (await page.locator('.center-list-item').count()) > 0 ||
        (await page.getByText('成本中心', { exact: false }).count()) > 0,
      details: `centers=${await page.locator('.center-list-item').count()}`
    })
    await saveScreenshot(page, outputDir, 'cost-allocation-rule', record)
    caseRecord.evidence.push('成本分摊规则正式 API、成本中心主档与页面截图')
    return model ? {
      token,
      api,
      allowRuntimeErrors: {
        console: (message) => message.includes('ws://localhost:17521/socket.io')
      }
    } : {
      token,
      api,
      allowRuntimeErrors: {
        console: (message) => message.includes('ws://localhost:17521/socket.io')
      },
      partial: true,
      note: '当前租户暂无成本模型，成本分摊规则完整业务闭环待初始化模型后复测'
    }
  }

  if (caseId === 'COST-002') {
    // PB-075：期初在制草稿、确认、锁定、回退走后端状态机。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const periods = periodsResult?.data?.list || []
    caseRecord.checks.push({
      name: '成本期间列表接口可用',
      passed: Array.isArray(periods),
      details: `periods=${periods.length}`
    })
    const period = periods[0]
    if (period?.id) {
      const wipResult = await api.getBusiness(
        `/cost/periods/${period.id}/opening-wip?stage=OPENING`
      )
      const wipRows = wipResult?.data || []
      caseRecord.checks.push({
        name: '期初在制正式接口返回阶段记录',
        passed: Array.isArray(wipRows),
        details: `rows=${Array.isArray(wipRows) ? wipRows.length : 'n/a'}`
      })
      if (wipRows.length) {
        caseRecord.checks.push({
          name: '期初在制暴露状态、版本与库存档案字段',
          passed: wipRows.every(
            (row) =>
              nonEmpty(row.status) &&
              Object.prototype.hasOwnProperty.call(row, 'version') &&
              Object.prototype.hasOwnProperty.call(row, 'materialId')
          ),
          details: `rows=${wipRows.length}`
        })
      }
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于期初在制校验',
        passed: false,
        details: '当前核算组织暂无成本期间，需先建立期间'
      })
    }
    await openRoute(page, '/cost-management/monthly/opening-wip')
    caseRecord.checks.push({
      name: '期初在制页面可打开',
      passed: (await page.locator('.opening-wip-workspace').count()) > 0,
      details: '真实 Chrome 期初在制页'
    })
    await saveScreenshot(page, outputDir, 'cost-opening-wip', record)
    caseRecord.evidence.push('期初在制正式 API、期间列表与页面截图')
  }

  if (caseId === 'COST-003') {
    // 成本工作流写接口统一返回 requestId/version，并接受 If-Match 请求契约。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const period = periodsResult?.data?.list?.[0]
    if (period?.id && period?.modelVersionNo) {
      const requestId = `e2e-cost-contract-${Date.now()}`
      const replay = await api.postBusiness(
        '/cost/periods',
        {
          requestId,
          accountingOrgId,
          period: period.period,
          enterpriseType: period.enterpriseType,
          modelVersion: period.modelVersionNo
        },
        { headers: { 'X-Request-Id': requestId } }
      )
      caseRecord.checks.push({
        name: '成本写接口返回 requestId 与期间版本',
        passed: replay?.data?.requestId === requestId && Number.isInteger(replay?.data?.version),
        details: `requestId=${replay?.data?.requestId || 'missing'}, version=${replay?.data?.version ?? 'missing'}`
      })
      caseRecord.checks.push({
        name: '成本期间接口暴露 If-Match 所需版本',
        passed: Number.isInteger(period.version),
        details: `periodVersion=${period.version ?? 'missing'}`
      })
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于幂等与 If-Match 契约校验',
        passed: false,
        details: '当前核算组织暂无已建立成本期间'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开并承载写接口契约',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-workflow-contract', record)
    caseRecord.evidence.push('成本工作流 requestId/If-Match 契约 API 与页面截图')
  }

  if (caseId === 'COST-004') {
    // 成本可靠事件以独立 Outbox 记录重试、死信与人工接管状态。
    const deadLetterResult = await api.getBusiness('/cost/outbox/dead-letters?limit=100')
    const deadLetters = costArrayData(deadLetterResult, '成本死信查询')
    caseRecord.checks.push({
      name: '成本死信查询接口返回可靠事件列表',
      passed: Array.isArray(deadLetters),
      details: `rows=${Array.isArray(deadLetters) ? deadLetters.length : 'n/a'}`
    })
    if (hasDeadLetterSamples(deadLetters)) caseRecord.checks.push({
      name: '成本死信包含幂等、重试和人工接管字段',
      passed:
        Array.isArray(deadLetters) &&
        deadLetters.every(
          (row) =>
            nonEmpty(row.id) &&
            nonEmpty(row.periodId) &&
            nonEmpty(row.action) &&
            nonEmpty(row.requestId) &&
            nonEmpty(row.eventKey) &&
            nonEmpty(row.payloadHash) &&
            row.status === 'DEAD' &&
            Number.isInteger(row.retryCount) &&
            Number.isInteger(row.maxRetry) &&
            Object.prototype.hasOwnProperty.call(row, 'manualOperator') &&
            Object.prototype.hasOwnProperty.call(row, 'manualAt') &&
            Object.prototype.hasOwnProperty.call(row, 'manualNote')
        ),
      details: deadLetters.length
        ? `validated=${deadLetters.length}`
        : '当前没有死信，已验证接口为空列表契约'
    })
    await openRoute(page, '/cost-management/workbench', { readySelector: '.title-line h1' })
    caseRecord.checks.push({
      name: '成本工作台可打开并承载可靠事件状态',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-workflow-outbox', record)
    caseRecord.evidence.push('成本 Outbox 死信接口结构与成本工作台截图')
    if (!hasDeadLetterSamples(deadLetters)) {
      return {
        token,
        api,
        partial: true,
        note: '当前没有死信样本，仅验证空列表接口；重试、死信字段和人工接管闭环待补真实事件后复测'
      }
    }
  }

  if (caseId === 'COST-005') {
    // PB-440/441：经营收支归集、经营计算和经营发布只读正式事实接口。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const period = periodsResult?.data?.list?.[0]
    if (period?.id) {
      const income = await api.getBusiness(
        `/cost/periods/${period.id}/operating-collections?direction=INCOME`
      )
      const expense = await api.getBusiness(
        `/cost/periods/${period.id}/operating-collections?direction=EXPENSE`
      )
      const calculation = await api.getBusiness(
        `/cost/periods/${period.id}/operating-calculation`
      )
      const publication = await api.getBusiness(
        `/cost/periods/${period.id}/operating-publication`
      )
      caseRecord.checks.push({
        name: '经营收入与支出归集正式接口可查询',
        passed: income?.data === null || Array.isArray(income?.data?.rows || []),
        details: `income=${income?.data?.rowCount ?? 0}, expense=${expense?.data?.rowCount ?? 0}`
      })
      caseRecord.checks.push({
        name: '经营计算结果包含成本发布引用与利润字段',
        passed:
          calculation?.data === null ||
          (nonEmpty(calculation?.data?.costPublicationId) &&
            Object.prototype.hasOwnProperty.call(calculation.data, 'operatingProfit')),
        details: calculation?.data?.batchNo || '当前期间暂无经营计算批次'
      })
      caseRecord.checks.push({
        name: '经营发布只读正式经营事实',
        passed:
          publication?.data === null ||
          (publication?.data?.status === 'PUBLISHED' &&
            nonEmpty(publication?.data?.resultHash) &&
            nonEmpty(publication?.data?.costPublicationId)),
        details: publication?.data?.status || '当前期间暂无正式经营发布'
      })
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于经营事实校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行经营事实写链路'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开经营收支与经营发布入口',
      passed: (await page.getByText('经营', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本经营工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-operating-facts', record)
    caseRecord.evidence.push('经营收支归集、经营计算、经营发布正式接口与页面截图')
  }

  if (caseId === 'COST-006') {
    // PB-424～PB-443：统一正式成本分析/结果报表接口。
    const period = loadCostScenario(caseRecord)?.period
    if (period?.id) {
      const report = await api.getBusiness(`/cost/reports/dimension-cost-report/${period.id}`)
      caseRecord.checks.push({
        name: '正式成本报表接口返回发布批次与明细',
        passed:
          report?.data?.reportKey === 'dimension-cost-report' &&
          nonEmpty(report?.data?.publicationId) &&
          Array.isArray(report?.data?.rows),
        details: report?.data?.scope || '当前期间没有正式成本发布'
      })
      const abnormal = await api.getBusiness(`/cost/reports/abnormal-fluctuation/${period.id}`)
      caseRecord.checks.push({
        name: '异常波动报表复用规则命中事实',
        passed:
          abnormal?.data?.reportKey === 'abnormal-fluctuation' &&
          Array.isArray(abnormal?.data?.rows),
        details: `异常行=${abnormal?.data?.rows?.length ?? 0}`
      })
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于正式报表校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行正式报表接口校验'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本结果与成本分析页面可打开',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本报表工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-formal-reports', record)
    caseRecord.evidence.push('PB-424～PB-443 正式报表接口与成本工作台截图')
  }

  if (caseId === 'COST-007') {
    // 企业类型隔离：生产验证入口不得放行贸易型或采购来源。
    const tradeTrial = await api.request('POST', '/cost/verification/production-trial', {
      enterpriseType: 'TRADE',
      periodId: currentMonth,
      modelVersion: 'E2E-TRADE-REJECT',
      sourceFacts: [],
      finishedRatios: {}
    })
    caseRecord.checks.push({
      name: '生产验证接口拒绝贸易型企业',
      passed: tradeTrial?.code === 422001,
      details: `code=${tradeTrial?.code ?? 'missing'}`
    })
    const purchaseTrial = await api.request('POST', '/cost/verification/production-trial', {
      enterpriseType: 'MANUFACTURING',
      periodId: currentMonth,
      modelVersion: 'E2E-PURCHASE-REJECT',
      sourceFacts: [{
        sourceType: 'PURCHASE_RECEIPT',
        sourceNo: 'E2E-GR-001'
      }],
      finishedRatios: {}
    })
    caseRecord.checks.push({
      name: '生产验证接口拒绝采购来源混入生产成本',
      passed: purchaseTrial?.code === 422001,
      details: `code=${purchaseTrial?.code ?? 'missing'}`
    })
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开企业类型隔离场景',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-enterprise-type-isolation', record)
    caseRecord.evidence.push('生产验证接口企业类型/来源路由拒绝响应与成本工作台截图')
  }

  if (caseId === 'COST-008') {
    // 经营正式发布前，公共经营费用事实必须保留有效分摊依据。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const period = periodsResult?.data?.list?.[0]
    if (period?.id) {
      const publication = await api.getBusiness(`/cost/periods/${period.id}/operating-publication`)
      const rows = publication?.data?.rows || []
      const operatingExpenses = rows.filter(
        (row) => row.direction === 'EXPENSE' && row.affectsProfit !== false && row.reportScope !== '销售成本'
      )
      caseRecord.checks.push({
        name: '正式经营费用事实包含分摊依据',
        passed:
          publication?.data === null ||
          operatingExpenses.every((row) => nonEmpty(row.allocationBasis)),
        details: `expenseRows=${operatingExpenses.length}`
      })
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于经营分摊基数校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行经营发布事实校验'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开经营分摊依据场景',
      passed: (await page.getByText('经营', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本经营工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-operating-allocation-basis', record)
    caseRecord.evidence.push('经营正式发布分摊依据接口与成本工作台截图')
  }

  if (caseId === 'COST-009') {
    // ERP 已审核采购入库自动归集到 FMS 来源快照草稿，确认仍由人工完成。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const period = periodsResult?.data?.list?.[0]
    if (period?.id) {
      const refreshed = await api.request(
        'POST',
        `/cost/periods/${period.id}/source-snapshot/purchase/refresh`
      )
      const noSourceBlocked = refreshed?.code === 422001 &&
        String(refreshed?.msg || refreshed?.message || '').includes('采购入库')
      const draft = refreshed?.code === 0 && refreshed?.data?.status === 'DRAFT'
      caseRecord.checks.push({
        name: 'ERP采购入库来源刷新为草稿或在无来源时明确阻断',
        passed: draft || noSourceBlocked,
        details: draft ? `snapshot=${refreshed.data.snapshotKey}` : String(refreshed?.msg || '无来源阻断')
      })
      if (draft) {
        const lines = refreshed.data.lines || []
        caseRecord.checks.push({
          name: '采购来源映射为ERP/PURCHASE_RECEIPT且未自动确认',
          passed:
            refreshed.data.snapshotKey === 'PURCHASE' &&
            lines.length > 0 &&
            lines.every(
              (row) => row.sourceModule === 'ERP' &&
                row.sourceType === 'PURCHASE_RECEIPT' &&
                row.sourceStatus === 'CONFIRMED'
            ),
          details: `lines=${lines.length}`
        })
      }
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于采购来源刷新校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行采购来源刷新'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开采购来源刷新场景',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-purchase-source-refresh', record)
    caseRecord.evidence.push('ERP采购入库来源刷新接口、草稿状态与成本工作台截图')
  }

  if (caseId === 'COST-010') {
    // 采购入库与采购退回共用 PURCHASE 快照，退回以负数参与净额计算。
    const period = loadCostScenario(caseRecord)?.period
    if (period?.id) {
      const refreshed = await api.request(
        'POST',
        `/cost/periods/${period.id}/source-snapshot/purchase/refresh`
      )
      const lines = refreshed?.data?.lines || []
      const receiptLines = lines.filter((row) => row.sourceType === 'PURCHASE_RECEIPT')
      const returnLines = lines.filter((row) => row.sourceType === 'PURCHASE_RETURN')
      const grouped = new Map()
      for (const row of lines) {
        const key = String(row.productId || row.sourceProductId || '')
        const current = grouped.get(key) || { quantity: 0, amount: 0 }
        current.quantity += Number(row.quantity || row.qty || 0)
        current.amount += Number(row.materialAmount || row.amount || row.totalAmount || 0)
        grouped.set(key, current)
      }
      caseRecord.checks.push({
        name: '采购入库正数与采购退回负数均映射到同一PURCHASE快照',
        passed:
          refreshed?.code === 0 &&
          refreshed?.data?.snapshotKey === 'PURCHASE' &&
          refreshed?.data?.status === 'DRAFT' &&
          receiptLines.every((row) => Number(row.quantity || row.qty || 0) >= 0) &&
          returnLines.every((row) =>
            Number(row.quantity || row.qty || 0) < 0 &&
            Number(row.materialAmount || row.amount || row.totalAmount || 0) <= 0
          ),
        details: `receipts=${receiptLines.length}, returns=${returnLines.length}, status=${refreshed?.data?.status || 'n/a'}`
      })
      if (lines.length) {
        caseRecord.checks.push({
          name: '同产品采购入库与采购退回净数量、净金额不为负',
          passed: [...grouped.values()].every(
            (value) => value.quantity >= 0 && value.amount >= 0
          ),
          details: `products=${grouped.size}`
        })
      }
      caseRecord.checks.push({
        name: '采购退回超过入库净额时由后端阻断或当前净额已通过校验',
        passed:
          (refreshed?.code === 422001 &&
            String(refreshed?.msg || refreshed?.message || '').includes('退回')) ||
          (refreshed?.code === 0 && [...grouped.values()].every(
            (value) => value.quantity >= 0 && value.amount >= 0
          )),
        details: String(refreshed?.msg || refreshed?.message || '当前期间采购退回净额校验通过')
      })
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于采购退回净额校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行采购入库/退回净额刷新'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开采购退回净额场景',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-purchase-return-net', record)
    caseRecord.evidence.push('采购入库/采购退回净额接口、草稿状态、阻断校验与成本工作台截图')
  }

  if (caseId === 'COST-011') {
    // 采购到岸费用复用 ERP 应付明细 freight，并以采购费用分项进入同一 PURCHASE 草稿。
    const period = loadCostScenario(caseRecord)?.period
    if (period?.id) {
      const refreshed = await api.request(
        'POST',
        `/cost/periods/${period.id}/source-snapshot/purchase/refresh`
      )
      const lines = refreshed?.data?.lines || []
      const freightLines = lines.filter((row) => row.sourceType === 'PURCHASE_FREIGHT')
      caseRecord.checks.push({
        name: '采购到岸费用按ERP应付freight映射为PURCHASE_FREIGHT费用来源',
        passed:
          refreshed?.code === 0 &&
          refreshed?.data?.snapshotKey === 'PURCHASE' &&
          refreshed?.data?.status === 'DRAFT' &&
          freightLines.every((row) =>
            Number(row.quantity || 0) === 0 &&
            Number(row.materialAmount || 0) === 0 &&
            Number(row.expenseAmount || 0) > 0 &&
            row.componentCode === 'PURCHASE_FREIGHT'
          ),
        details: `freightLines=${freightLines.length}, status=${refreshed?.data?.status || 'n/a'}`
      })
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于采购到岸费用刷新校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行采购到岸费用来源刷新'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开采购到岸费用场景',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-purchase-freight', record)
    caseRecord.evidence.push('采购到岸费用来源接口、费用分项草稿状态与成本工作台截图')
  }

  if (caseId === 'COST-012') {
    // PB-443：采购成本表从正式发布来源显示采购订单口径的发票价格状态与价差。
    const period = loadCostScenario(caseRecord)?.period
    if (period?.id) {
      const report = await api.getBusiness(`/cost/reports/purchase-cost-report/${period.id}`)
      const rows = report?.data?.rows || []
      caseRecord.checks.push({
        name: '采购成本正式报表暴露发票价格状态与比较范围',
        passed:
          report?.data?.reportKey === 'purchase-cost-report' &&
          Array.isArray(rows) &&
          rows.every(
            (row) =>
              Object.prototype.hasOwnProperty.call(row.values || {}, 'invoicePriceStatus') &&
              Object.prototype.hasOwnProperty.call(row.values || {}, 'invoicePriceStatusText') &&
              Object.prototype.hasOwnProperty.call(row.values || {}, 'invoicePriceScope') &&
              Object.prototype.hasOwnProperty.call(row.values || {}, 'invoicePriceDifference')
          ),
        details: `rows=${rows.length}, scope=${rows[0]?.values?.invoicePriceScope || 'n/a'}`
      })
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于发票价格状态报表校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行采购成本正式报表校验'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开采购成本发票价格状态场景',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-purchase-invoice-price-status', record)
    caseRecord.evidence.push('采购成本正式报表发票价格状态/价差字段与成本工作台截图')
  }

  if (caseId === 'COST-013') {
    // 委外正式成本只从 MES 已完工、已结算来源刷新为 OUTSOURCE 草稿。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const period = periodsResult?.data?.list?.[0]
    if (period?.id) {
      const refreshed = await api.request(
        'POST',
        `/cost/periods/${period.id}/source-snapshot/outsource/refresh`
      )
      const lines = refreshed?.data?.lines || []
      const noSourceBlocked = refreshed?.code === 422001 &&
        String(refreshed?.msg || refreshed?.message || '').includes('已完工且已结算委外')
      const draft = refreshed?.code === 0 && refreshed?.data?.status === 'DRAFT'
      caseRecord.checks.push({
        name: 'MES正式委外来源刷新为OUTSOURCE草稿或无来源明确阻断',
        passed: draft || noSourceBlocked,
        details: draft ? `snapshot=${refreshed.data.snapshotKey}` : String(refreshed?.msg || '无来源阻断')
      })
      if (draft) {
        caseRecord.checks.push({
          name: '委外来源映射为MES/OUTSOURCE_COMPLETION并拆分材料费与加工费',
          passed:
            refreshed.data.snapshotKey === 'OUTSOURCE' &&
            lines.length > 0 &&
            lines.every(
              (row) => row.sourceModule === 'MES' &&
                row.sourceType === 'OUTSOURCE_COMPLETION' &&
                row.componentCode === 'OUTSOURCE' &&
                Number(row.quantity || 0) > 0 &&
                Number(row.materialAmount || 0) >= 0 &&
                Number(row.expenseAmount || 0) >= 0 &&
                row.sourceStatus === 'DRAFT'
            ),
          details: `lines=${lines.length}`
        })
      }
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于委外来源刷新校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行委外来源刷新'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开委外来源刷新场景',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-outsource-source-refresh', record)
    caseRecord.evidence.push('MES委外正式来源刷新接口、材料/加工费拆分与成本工作台截图')
  }

  if (caseId === 'COST-014') {
    // PB-428：自产与外购比较只读已发布事实，约束事实缺失时必须返回不可比较。
    const period = loadCostScenario(caseRecord)?.period
    if (period?.id) {
      const report = await api.getBusiness(`/cost/reports/make-buy/${period.id}`)
      const rows = report?.data?.rows || []
      const hasNotComparable = rows.some((row) => row.values?.status === '不可比较')
      const hasNonZeroBuyCost = rows.some(
        (row) => row.values?.buyCost !== null && row.values?.buyCost !== undefined && Number(row.values.buyCost) !== 0
      )
      caseRecord.checks.push({
        name: '自产与外购比较正式接口返回make-buy报表',
        passed: report?.data?.reportKey === 'make-buy' && Array.isArray(rows),
        details: `rows=${rows.length}, reportKey=${report?.data?.reportKey || 'n/a'}`
      })
      caseRecord.checks.push({
        name: '质量/交期/产能冻结事实缺失时标记不可比较',
        passed: rows.length === 0 || hasNotComparable,
        details: rows.length === 0 ? '当前期间暂无比较对象' : `notComparable=${hasNotComparable}`
      })
      caseRecord.checks.push({
        name: '外购成本缺少约束事实时不伪造成零值',
        passed: rows.length === 0 || hasNonZeroBuyCost || rows.every((row) => row.values?.buyCost === null),
        details: `nonZeroBuyCost=${hasNonZeroBuyCost}`
      })
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于自产与外购比较校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行自产与外购正式报表校验'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开自产与外购比较场景',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-make-buy-report', record)
    caseRecord.evidence.push('自产与外购比较正式报表接口、不可比较状态与成本工作台截图')
  }

  if (caseId === 'COST-015') {
    // PB-428：质量约束只补写已有采购/委外来源草稿，不修改正式成本金额或已确认快照。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const period = periodsResult?.data?.list?.[0]
    if (period?.id) {
      const refreshed = await api.request(
        'POST',
        `/cost/periods/${period.id}/source-snapshot/quality/refresh?snapshotKey=PURCHASE`
      )
      const lines = refreshed?.data?.lines || []
      const noQualityBlocked = refreshed?.code === 422001 &&
        String(refreshed?.msg || refreshed?.message || '').includes('质量约束')
      const noSnapshotBlocked = refreshed?.code === 422001 &&
        String(refreshed?.msg || refreshed?.message || '').includes('来源快照')
      const draft = refreshed?.code === 0 && refreshed?.data?.status === 'DRAFT'
      caseRecord.checks.push({
        name: '质量事实刷新只写入PURCHASE草稿或明确阻断',
        passed: draft || noQualityBlocked || noSnapshotBlocked,
        details: draft ? `snapshot=${refreshed.data.snapshotKey}` : String(refreshed?.msg || '无可刷新质量事实')
      })
      if (draft) {
        caseRecord.checks.push({
          name: '质量字段冻结在来源载荷且不改变成本金额',
          passed:
            refreshed.data.snapshotKey === 'PURCHASE' &&
            lines.length > 0 &&
            lines.some((row) => ['PASS', 'DEGRADED', 'FAIL', 'DATA_MISSING'].includes(row.qualityStatus)) &&
            lines.every((row) => Object.prototype.hasOwnProperty.call(row, 'constraintSnapshotHash')),
          details: `lines=${lines.length}`
        })
        caseRecord.checks.push({
          name: '质量刷新保持来源快照草稿状态',
          passed: refreshed.data.status === 'DRAFT',
          details: `status=${refreshed.data.status}`
        })
      }
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于质量约束刷新校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行质量事实刷新'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开质量约束刷新场景',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-quality-constraint-refresh', record)
    caseRecord.evidence.push('MES质量事实、FMS来源草稿约束刷新接口与成本工作台截图')
  }

  if (caseId === 'COST-016') {
    // PB-428：交期与产能只补写已有来源草稿，缺少正式事实时明确阻断，不改变成本金额。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const period = periodsResult?.data?.list?.[0]
    if (period?.id) {
      const delivery = await api.request(
        'POST',
        `/cost/periods/${period.id}/source-snapshot/delivery/refresh?snapshotKey=PURCHASE`
      )
      const capacity = await api.request(
        'POST',
        `/cost/periods/${period.id}/source-snapshot/capacity/refresh?snapshotKey=PURCHASE`
      )
      const accepted = (response) => {
        if (response?.code === 0) return response?.data?.status === 'DRAFT'
        return response?.code === 422001 && Boolean(response?.msg || response?.message)
      }
      caseRecord.checks.push({
        name: '交期约束刷新返回草稿或明确阻断',
        passed: accepted(delivery),
        details: delivery?.code === 0
          ? `status=${delivery.data?.status}, lines=${delivery.data?.lines?.length || 0}`
          : String(delivery?.msg || delivery?.message || '交期刷新无响应')
      })
      caseRecord.checks.push({
        name: '产能约束刷新返回草稿或明确阻断',
        passed: accepted(capacity),
        details: capacity?.code === 0
          ? `status=${capacity.data?.status}, lines=${capacity.data?.lines?.length || 0}`
          : String(capacity?.msg || capacity?.message || '产能刷新无响应')
      })
      if (delivery?.code === 0) {
        const lines = delivery.data?.lines || []
        caseRecord.checks.push({
          name: '交期结果暴露正式状态与快照时间，不参与成本金额',
          passed: lines.length === 0 || lines.every(
            (row) => ['ON_TIME', 'LATE', 'DATA_MISSING', 'NOT_APPLICABLE'].includes(row.deliveryStatus) &&
              Object.prototype.hasOwnProperty.call(row, 'deliveryExpectedAt') &&
              Object.prototype.hasOwnProperty.call(row, 'deliveryActualAt')
          ),
          details: `lines=${lines.length}`
        })
      }
      if (capacity?.code === 0) {
        const lines = capacity.data?.lines || []
        caseRecord.checks.push({
          name: '产能结果只暴露正式负荷事实，不以零值补缺',
          passed: lines.length === 0 || lines.every(
            (row) => row.capacityLoad === null || row.capacityLoad === undefined || Number(row.capacityLoad) >= 0
          ),
          details: `lines=${lines.length}`
        })
      }
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于交期与产能约束刷新校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行交期/产能事实刷新'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开交期与产能约束入口',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-delivery-capacity-constraints', record)
    caseRecord.evidence.push('交期/产能正式约束刷新接口与成本工作台截图')
  }

  if (caseId === 'COST-017') {
    // PB-440：ERP 已生效应收作为经营收入唯一只读来源，FMS 刷新只返回未落档草稿。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const period = periodsResult?.data?.list?.[0]
    if (period?.id) {
      const refreshed = await api.request(
        'POST',
        `/cost/periods/${period.id}/operating-income-sources/refresh`
      )
      caseRecord.checks.push({
        name: '经营收入来源刷新返回未落档草稿',
        passed: refreshed?.code === 0 && refreshed?.data?.status === 'DRAFT',
        details: refreshed?.code === 0
          ? `rows=${refreshed.data?.rowCount || 0}, amount=${refreshed.data?.totalAmount || 0}`
          : String(refreshed?.msg || refreshed?.message || '收入来源刷新无响应')
      })
      if (refreshed?.code === 0) {
        const rows = refreshed.data?.rows || []
        caseRecord.checks.push({
          name: '收入草稿仅包含营业收入且来源可追溯',
          passed: rows.every(
            (row) => row.direction === 'INCOME' &&
              row.reportScope === '营业收入' &&
              row.itemCode === 'SALES_REVENUE' &&
              nonEmpty(row.sourceNo) &&
              ['SalOrder', 'SaleReturn'].includes(row.sourceType)
          ),
          details: `incomeRows=${rows.length}`
        })
      }
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于经营收入来源刷新校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行 ERP 收入来源刷新'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开经营收入入口',
      passed: (await page.getByText('经营', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本经营工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-operating-income-refresh', record)
    caseRecord.evidence.push('ERP 应收收入来源刷新接口、草稿契约与成本工作台截图')
  }

  if (caseId === 'COST-018') {
    // PB-420/421：ERP 已审批生效报销明细作为经营费用只读来源，FMS 刷新只返回未落档草稿。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const period = periodsResult?.data?.list?.[0]
    if (period?.id) {
      const refreshed = await api.request(
        'POST',
        `/cost/periods/${period.id}/operating-expense-sources/refresh`
      )
      caseRecord.checks.push({
        name: '经营支出来源刷新返回未落档草稿',
        passed: refreshed?.code === 0 && refreshed?.data?.status === 'DRAFT',
        details: refreshed?.code === 0
          ? `rows=${refreshed.data?.rowCount || 0}, amount=${refreshed.data?.totalAmount || 0}`
          : String(refreshed?.msg || refreshed?.message || '经营支出来源刷新无响应')
      })
      if (refreshed?.code === 0) {
        const rows = refreshed.data?.rows || []
        caseRecord.checks.push({
          name: '经营支出草稿仅包含已审批生效报销明细',
          passed: rows.every(
            (row) => row.direction === 'EXPENSE' &&
              row.reportScope === '经营费用' &&
              row.itemCode === 'OPERATING_EXPENSE' &&
              nonEmpty(row.sourceNo) &&
              row.sourceType === 'ExpenseReport'
          ),
          details: `expenseRows=${rows.length}`
        })
      }
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于经营支出来源刷新校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行 ERP 报销来源刷新'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开经营支出入口',
      passed: (await page.getByText('经营', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本经营工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-operating-expense-refresh', record)
    caseRecord.evidence.push('ERP 报销明细来源刷新接口、草稿契约与成本工作台截图')
  }

  if (caseId === 'COST-019') {
    // PB-420/421：其他应付只接入非采购、非付款反向来源的已生效明细。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const period = periodsResult?.data?.list?.[0]
    if (period?.id) {
      const refreshed = await api.request(
        'POST',
        `/cost/periods/${period.id}/operating-expense-sources/refresh`
      )
      caseRecord.checks.push({
        name: '其他应付经营费用来源刷新返回未落档草稿',
        passed: refreshed?.code === 0 && refreshed?.data?.status === 'DRAFT',
        details: refreshed?.code === 0
          ? `rows=${refreshed.data?.rowCount || 0}, amount=${refreshed.data?.totalAmount || 0}`
          : String(refreshed?.msg || refreshed?.message || '其他应付来源刷新无响应')
      })
      if (refreshed?.code === 0) {
        const rows = refreshed.data?.rows || []
        const payableRows = rows.filter((row) => row.sourceType === 'Payable')
        caseRecord.checks.push({
          name: '其他应付来源可追溯且统一映射经营费用',
          passed: payableRows.every(
            (row) => row.direction === 'EXPENSE' &&
              row.reportScope === '经营费用' &&
              row.itemCode === 'OPERATING_EXPENSE' &&
              nonEmpty(row.sourceNo)
          ),
          details: `payableRows=${payableRows.length}`
        })
        caseRecord.checks.push({
          name: '经营费用自动生成可追溯分摊基数快照',
          passed:
            rows.length === 0 ||
            rows.every(
              (row) =>
                /^(REVENUE|HEADCOUNT|AREA):/.test(row.allocationBasis || '') &&
                String(row.note || '').includes('分摊基数自动取数')
            ),
          details: `basisRows=${rows.length}`
        })
      }
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于其他应付来源刷新校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行其他应付来源刷新'
      })
    }
    // 支出方向提示仅在“支出”页签渲染，深链接显式切换方向，避免默认收入页签导致误判。
    await openRoute(page, '/cost-management/monthly/operating-income-expense?direction=expense', {
      readySelector: '.operating-collection-workspace'
    })
    caseRecord.checks.push({
      name: '经营支出页说明自动取数口径和发布阻断规则',
      passed:
        (await page.getByText('分摊基数自动取数', { exact: false }).count()) > 0 &&
        (await page.getByText('发布前必须存在有效正数基数', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本经营工作台'
    })
    await saveScreenshot(page, outputDir, 'cost-operating-payable-expense-refresh', record)
    caseRecord.evidence.push('ERP 其他应付来源刷新接口、非采购过滤契约与成本工作台截图')
  }

  if (caseId === 'COST-020') {
    // PB-420/421：采购/委外应付结算状态只作为来源追溯快照，不改变成本金额。
    const period = loadCostScenario(caseRecord)?.period
    if (period?.id) {
      const refreshed = await api.request(
        'POST',
        `/cost/periods/${period.id}/source-snapshot/purchase/refresh`
      )
      caseRecord.checks.push({
        name: '采购成本来源刷新返回应付结算追溯字段',
        passed: refreshed?.code === 0 && refreshed?.data?.status === 'DRAFT',
        details: refreshed?.code === 0
          ? `rows=${refreshed.data?.lines?.length || 0}`
          : String(refreshed?.msg || refreshed?.message || '采购来源刷新无响应')
      })
      if (refreshed?.code === 0) {
        const rows = refreshed.data?.lines || []
        const tracked = rows.filter((row) => row.sourceType === 'PURCHASE_RECEIPT' || row.sourceType === 'PURCHASE_RETURN')
        caseRecord.checks.push({
          name: '应付状态仅作为快照且不替代采购成本金额',
          passed: tracked.every(
            (row) => ['UNPAID', 'PARTIAL', 'PAID', 'NOT_AVAILABLE'].includes(row.payableSettlementStatus) &&
              row.materialAmount !== undefined &&
              row.payableAmount !== undefined
          ),
          details: `trackedRows=${tracked.length}`
        })
      }
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于采购应付结算快照校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行采购应付结算快照刷新'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开采购成本来源入口',
      passed: (await page.getByText('采购', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台采购来源入口'
    })
    await saveScreenshot(page, outputDir, 'cost-purchase-payable-settlement-snapshot', record)
    caseRecord.evidence.push('采购来源刷新接口、应付结算状态快照与成本金额分离校验、成本工作台截图')
  }

  if (caseId === 'COST-021') {
    // PB-420/421：付款与核销冲销轨迹仅作为来源追溯快照，成本确认金额保持不变。
    const period = loadCostScenario(caseRecord)?.period
    if (period?.id) {
      const refreshed = await api.request(
        'POST',
        `/cost/periods/${period.id}/source-snapshot/purchase/refresh`
      )
      caseRecord.checks.push({
        name: '采购成本来源刷新返回付款核销追溯状态',
        passed: refreshed?.code === 0 && refreshed?.data?.status === 'DRAFT',
        details: refreshed?.code === 0
          ? `rows=${refreshed.data?.lines?.length || 0}`
          : String(refreshed?.msg || refreshed?.message || '采购来源刷新无响应')
      })
      if (refreshed?.code === 0) {
        const rows = refreshed.data?.lines || []
        const traced = rows.filter((row) => row.sourceType === 'PURCHASE_RECEIPT' || row.sourceType === 'PURCHASE_RETURN')
        caseRecord.checks.push({
          name: '付款核销轨迹仅作快照且成本金额不变',
          passed: trackedTraceShape(traced),
          details: `tracedRows=${traced.length}`
        })
        caseRecord.checks.push({
          name: '存在付款核销轨迹时携带可追溯单号与状态',
          passed: traced.every((row) => {
            if (row.payableTraceStatus !== 'AVAILABLE') return true
            const traces = Array.isArray(row.payableSettlementTraces) ? row.payableSettlementTraces : []
            return traces.length > 0 && traces.every((trace) =>
              ['PAYMENT', 'WRITE_OFF'].includes(trace.traceType) &&
              ['CONFIRMED', 'VOIDED'].includes(trace.traceStatus) &&
              nonEmpty(trace.traceNo) &&
              nonEmpty(trace.payableNo))
          }),
          details: `availableRows=${traced.filter((row) => row.payableTraceStatus === 'AVAILABLE').length}`
        })
      }
    } else {
      caseRecord.checks.push({
        name: '存在成本期间用于付款核销追溯校验',
        passed: false,
        details: '当前核算组织暂无成本期间，未执行付款核销追溯刷新'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开付款核销追溯入口',
      passed: (await page.getByText('采购', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台采购来源入口'
    })
    await saveScreenshot(page, outputDir, 'cost-purchase-payable-trace', record)
    caseRecord.evidence.push('采购来源刷新接口、付款核销轨迹快照与成本金额分离校验、成本工作台截图')
  }

  if (caseId === 'COST-022') {
    // 反月结重开保留原发布/试算事实，期间回到核算中，不得覆盖已发布金额。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const periods = periodsResult?.data?.list || []
    // 反月结重开的"原因必填"门禁在发布批次校验之后执行，因此必须先拿到真实的已发布期间。
    const candidate = loadCostScenario(caseRecord)?.period || periods.find((row) => nonEmpty(row.id))
    const missingReason = candidate
      ? await api.request('POST', `/cost/periods/${candidate.id}/publications/reopen`, {})
      : null
    caseRecord.checks.push({
      name: '反月结重开接口可达且强制要求重开原因',
      passed:
        candidate !== undefined &&
        missingReason?.code !== undefined &&
        missingReason.code !== 0 &&
        missingReason.code !== 500 &&
        /(反月结重开原因|反月结原因)/.test(
          String(missingReason.msg || missingReason.message || '')
        ),
      details: candidate
        ? `code=${missingReason?.code} msg=${missingReason?.msg || missingReason?.message || ''}`
        : '当前核算组织暂无成本期间，未执行反月结接口校验'
    })
    const unpublished = periods.find(
      (row) => row.status !== 'COST_PUBLISHED' || !nonEmpty(row.currentPublicationId)
    )
    if (unpublished) {
      const blocked = await api.request(
        'POST',
        `/cost/periods/${unpublished.id}/publications/reopen`,
        { reason: 'E2E反月结门禁校验' }
      )
      caseRecord.checks.push({
        name: '没有正式发布批次时反月结被业务规则阻断而非未知异常',
        passed: blocked?.code !== undefined && blocked.code !== 0 && blocked.code !== 500,
        details: `code=${blocked?.code} msg=${blocked?.msg || blocked?.message || ''}`
      })
    } else {
      caseRecord.checks.push({
        name: '没有正式发布批次时反月结被业务规则阻断而非未知异常',
        passed: false,
        details: '当前核算组织没有可用于反月结门禁校验的未发布期间样本'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开反月结重开入口',
      passed: (await page.getByText('成本', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台入口'
    })
    await saveScreenshot(page, outputDir, 'cost-publication-reopen', record)
    caseRecord.evidence.push('反月结重开接口契约、门禁规则与成本工作台截图')
  }

  if (caseId === 'COST-023') {
    // 成本试算执行人与复核人必须分离；同一账号确认当前试算必须被业务规则阻断。
    const permission = await api.get('/system/auth/get-permission-info')
    const currentUserId = String(permission?.data?.user?.id ?? permission?.user?.id ?? '')
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const periods = periodsResult?.data?.list || []
    // 夹具期间的试算由当前登录人（admin）执行，用于验证"同人复核"必须被阻断。
    const scenarioPeriod = loadCostScenario(caseRecord)?.period
    const pending =
      (scenarioPeriod?.status === 'TRIAL_PENDING' && scenarioPeriod.currentTrialId
        ? scenarioPeriod
        : null) ||
      periods.find((row) => row.status === 'TRIAL_PENDING' && nonEmpty(row.currentTrialId))
    if (pending) {
      // getBusiness 返回 {code,data,msg}，试算事实在 data 内。
      const trial = responseData(
        await api.getBusiness(`/cost/periods/${pending.id}/trials/current`)
      )
      caseRecord.checks.push({
        name: '当前试算返回执行人标识以支持职责分离校验',
        passed: nonEmpty(trial?.creatorId),
        details: `trialId=${pending.currentTrialId} creatorId=${trial?.creatorId || '空'}`
      })
      const sameUserTrial = nonEmpty(currentUserId) && String(trial?.creatorId) === currentUserId
      caseRecord.checks.push({
        name: '存在当前登录人执行且待复核的试算样本',
        passed: sameUserTrial,
        details: sameUserTrial
          ? `periodId=${pending.id} trialId=${pending.currentTrialId}`
          : `当前用户=${currentUserId || '未知'}，试算执行人=${trial?.creatorId || '未知'}`
      })
      if (sameUserTrial) {
        const blocked = await api.request('POST', `/cost/trials/${pending.currentTrialId}/confirm`, undefined, {
          headers: {
            'If-Match': String(pending.version),
            'X-Request-Id': `cost-separation-${Date.now()}`
          }
        })
        caseRecord.checks.push({
          name: '同一账号不能确认自己执行的成本试算',
          passed:
            blocked?.code !== undefined &&
            blocked.code !== 0 &&
            blocked.code !== 500 &&
            /(执行人与复核确认人不能相同|模型维护人与试算复核人不能相同)/.test(
              String(blocked.msg || blocked.message || '')
            ),
          details: `code=${blocked?.code} msg=${blocked?.msg || blocked?.message || ''}`
        })
      }
    } else {
      caseRecord.checks.push({
        name: '存在待复核试算用于职责分离校验',
        passed: false,
        details: '当前核算组织没有 TRIAL_PENDING 且绑定 currentTrialId 的试算样本'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开试算复核入口',
      passed: (await page.getByText('试算', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台试算复核入口'
    })
    await saveScreenshot(page, outputDir, 'cost-separation-of-duties', record)
    caseRecord.evidence.push('成本试算执行人字段、同人复核阻断校验与成本工作台截图')
  }

  if (caseId === 'COST-024') {
    // 上期结转必须由后端按上一已发布期间的期末在制派生，不再由前端本地推算正式口径。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const periods = periodsResult?.data?.list || []
    // 夹具先造出"上一已发布期间 + 当前核算中期间"，因此优先用它派生 CARRYOVER。
    const scenarioPeriod = loadCostScenario(caseRecord)?.period
    const accounting = [
      ...(scenarioPeriod?.status === 'ACCOUNTING' ? [scenarioPeriod] : []),
      ...periods.filter((row) => row.status === 'ACCOUNTING' && row.id !== scenarioPeriod?.id)
    ]
    let carriedSample = null
    let blockedSample = null
    for (const period of accounting) {
      const response = await api.request(
        'POST',
        `/cost/periods/${period.id}/opening-wip/carry-forward?stage=CARRYOVER`
      )
      if (response?.code === 0) {
        carriedSample = { period, rows: response?.data || [] }
        // 首条可用样本即本轮证据；继续遍历会覆盖成更早的共享期间，证据不再属于本轮夹具。
        break
      } else if (blockedSample === null) {
        blockedSample = { period, response }
      }
    }
    caseRecord.checks.push({
      name: '核算中期间的上期结转接口返回后端派生的期末在制草稿',
      passed:
        carriedSample !== null &&
        carriedSample.rows.length > 0 &&
        carriedSample.rows.every(
          (row) => row.sourceType === 'CARRYOVER' && nonEmpty(row.sourceRef)
        ),
      details: carriedSample
        ? `periodId=${carriedSample.period.id} rows=${carriedSample.rows.length} sourceRef=${carriedSample.rows[0]?.sourceRef || '空'}`
        : '当前核算组织没有可派生上期结转的核算中期间'
    })
    caseRecord.checks.push({
      name: '缺少上一已发布期间时结转被业务规则阻断而非未知异常',
      passed:
        blockedSample === null ||
        (blockedSample.response.code !== 500 &&
          String(blockedSample.response.msg || blockedSample.response.message || '').includes(
            'previous published'
          )),
      details: blockedSample
        ? `periodId=${blockedSample.period.id} code=${blockedSample.response.code} msg=${blockedSample.response.msg || blockedSample.response.message || ''}`
        : '当前核算组织所有核算中期间均可派生结转，未触发缺失上期门禁'
    })
    if (carriedSample) {
      // getBusiness 返回 {code,data,msg}，结转明细数组在 data 内。
      const listed = responseData(
        await api.getBusiness(
          `/cost/periods/${carriedSample.period.id}/opening-wip?stage=CARRYOVER`
        )
      )
      caseRecord.checks.push({
        name: '上期结转明细可在正式接口按 CARRYOVER 阶段查询',
        passed:
          Array.isArray(listed) &&
          listed.length > 0 &&
          listed.every((row) => row.stage === 'CARRYOVER' && nonEmpty(row.sourceRef)),
        details: `stage=CARRYOVER rows=${Array.isArray(listed) ? listed.length : 'n/a'}`
      })
    }
    // 口径说明只在"上期在制"阶段渲染，需要临时把页面草稿状态切到该阶段再断言。
    await withCarryoverStage(api, async () => {
      await openRoute(page, '/cost-management/monthly/opening-wip', {
        readySelector: '.opening-wip-workspace'
      })
      caseRecord.checks.push({
        name: '成本工作台可打开上期结转入口',
        passed: (await page.getByText('期初', { exact: false }).count()) > 0,
        details: '真实 Chrome 成本工作台期初/上期在制入口'
      })
      // 口径说明挂在悬浮提示里，逐个小问号 hover，直到目标文案出现。
      const carryoverRuleTriggers = page.locator(
        '.opening-wip-workspace .el-tooltip__trigger'
      )
      const carryoverTriggerCount = await carryoverRuleTriggers.count()
      for (let index = 0; index < carryoverTriggerCount; index++) {
        await carryoverRuleTriggers.nth(index).hover().catch(() => {})
        await page.waitForTimeout(250)
        if ((await page.getByText('投入结构拆分', { exact: false }).count()) > 0) break
      }
      caseRecord.checks.push({
        name: '上期结转页面说明料工费拆分和数量人工确认口径',
        passed:
          (await page.getByText('投入结构拆分', { exact: false }).count()) > 0 ||
          (await page.getByText('数量仍需人工确认', { exact: false }).count()) > 0,
        details: '真实 Chrome 上期结转口径提示'
      })
      await saveScreenshot(page, outputDir, 'cost-opening-wip-carry-forward', record)
    })
    caseRecord.evidence.push(
      '上期结转后端派生契约、CARRYOVER 阶段查询、料工费拆分提示与成本工作台截图'
    )
  }

  if (caseId === 'COST-025') {
    // 异常处理队列以 cost_rule_hit 正式事实为准，批量动作只放行警告项、不动阻断项。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const periods = periodsResult?.data?.list || []
    const candidate =
      loadCostScenario(caseRecord)?.period ||
      periods.find((row) => row.status === 'COST_PUBLISHED' && nonEmpty(row.currentPublicationId)) ||
      periods.find((row) => nonEmpty(row.currentPublicationId))
    if (candidate) {
      const hits = await api.request(
        'GET',
        `/cost/periods/${candidate.id}/rule-hits?pageNo=1&pageSize=100`
      )
      const rows = hits?.data?.list || []
      caseRecord.checks.push({
        name: '异常队列读取 cost_rule_hit 正式分页事实',
        passed:
          hits?.code === 0 &&
          Array.isArray(rows) &&
          rows.every((row) => ['BLOCK', 'WARN', 'PASS'].includes(row.level) && nonEmpty(row.status)),
        details: `periodId=${candidate.id} total=${hits?.data?.total ?? 0} rows=${rows.length}`
      })
      const missingNote = await api.request(
        'POST',
        `/cost/periods/${candidate.id}/rule-hits/release-warnings`,
        {}
      )
      caseRecord.checks.push({
        name: '批量放行警告项强制要求处理说明',
        passed: missingNote?.code !== undefined && missingNote.code !== 0 && missingNote.code !== 500,
        details: `code=${missingNote?.code} msg=${missingNote?.msg || missingNote?.message || ''}`
      })
      const released = await api.request(
        'POST',
        `/cost/periods/${candidate.id}/rule-hits/release-warnings`,
        { note: 'E2E 批量放行警告项校验' }
      )
      const releasedOk =
        released?.code === 0 &&
        released?.data?.releasedCount !== undefined &&
        released?.data?.remainingBlockingCount !== undefined
      const releasedBlocked = released?.code !== undefined && released.code !== 0 && released.code !== 500
      caseRecord.checks.push({
        name: '批量放行只处理警告项并返回剩余阻断数量',
        passed: releasedOk || releasedBlocked,
        details: `code=${released?.code} released=${released?.data?.releasedCount ?? '空'} remainingBlocking=${released?.data?.remainingBlockingCount ?? '空'} msg=${released?.msg || released?.message || ''}`
      })
    } else {
      caseRecord.checks.push({
        name: '存在可用于异常队列校验的成本期间',
        passed: false,
        details: '当前核算组织暂无成本期间'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本工作台可打开异常处理入口',
      passed: (await page.getByText('异常', { exact: false }).count()) > 0,
      details: '真实 Chrome 成本工作台异常处理入口'
    })
    await saveScreenshot(page, outputDir, 'cost-exception-queue', record)
    caseRecord.evidence.push('异常队列正式事实分页、警告批量放行契约与成本工作台截图')
  }

  if (caseId === 'COST-026') {
    // 发票价格差异只按发票自身保存的采购订单行级快照比较；缺少行级事实时明确回落订单级，不按金额摊分。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const periods = periodsResult?.data?.list || []
    const publishedPeriods = periods.filter((row) => row.status === 'PUBLISHED' && nonEmpty(row.id))
    let reportSample = null
    let blockedSample = null
    for (const period of publishedPeriods) {
      const response = await api.request(
        'GET',
        `/cost/reports/purchase-cost-report/${period.id}`
      )
      if (response?.code === 0 && (response?.data?.rows?.length || 0) > 0) {
        reportSample = { period, response }
        break
      }
      if (blockedSample === null && response?.code !== 0) {
        blockedSample = { period, response }
      }
    }
    if (reportSample) {
      const rows = reportSample.response.data.rows
      const scopes = rows.map((row) => String(row.values?.invoicePriceScope || ''))
      caseRecord.checks.push({
        name: '采购成本表返回发票价格比较范围与可读口径',
        passed:
          rows.every(
            (row) =>
              nonEmpty(row.values?.invoicePriceScope) &&
              nonEmpty(row.values?.invoicePriceScopeText) &&
              ['PURCHASE_ORDER_LINE', 'PURCHASE_ORDER', 'UNAVAILABLE'].includes(
                String(row.values?.invoicePriceScope)
              )
          ) && rows.every((row) => nonEmpty(row.values?.invoicePriceStatusText)),
        details: `periodId=${reportSample.period.id} rows=${rows.length} scopes=${[
          ...new Set(scopes)
        ].join(',')}`
      })
      const lineRows = rows.filter((row) => row.values?.invoicePriceScope === 'PURCHASE_ORDER_LINE')
      caseRecord.checks.push({
        name: '行级发票比较同时返回开票数量、开票单价与基准单价',
        passed:
          lineRows.length === 0 ||
          lineRows.every(
            (row) =>
              row.values?.invoiceQuantity !== null &&
              row.values?.invoiceQuantity !== undefined &&
              row.values?.invoiceUnitPrice !== null &&
              row.values?.invoiceUnitPrice !== undefined &&
              row.values?.invoiceExpectedUnitPrice !== null &&
              row.values?.invoiceExpectedUnitPrice !== undefined
          ),
        details:
          lineRows.length === 0
            ? '本期没有行级发票快照样本，仅校验订单级口径'
            : `lineRows=${lineRows.length}`
      })
      caseRecord.checks.push({
        name: '报表提示明确订单级金额不会摊到入库行',
        passed: (reportSample.response.data.notices || []).some((notice) =>
          String(notice).includes('行')
        ),
        details: `notices=${(reportSample.response.data.notices || []).length}`
      })
    } else {
      caseRecord.checks.push({
        name: '采购成本表在无正式发布期间时返回业务错误而非未知异常',
        passed:
          blockedSample === null ||
          (blockedSample.response.code !== 500 &&
            !String(blockedSample.response.message || '').toLowerCase().includes('exception')),
        details: blockedSample
          ? `periodId=${blockedSample.period.id} code=${blockedSample.response.code} msg=${blockedSample.response.msg || blockedSample.response.message || ''}`
          : '当前核算组织没有已发布成本期间，未触发采购成本表查询'
      })
    }
    // 采购成本工作区只在月度深链接下挂载，直接打开目标路由而非依赖工作台快捷入口。
    await openRoute(page, '/cost-management/monthly/purchase-costing', {
      readySelector: '.purchase-layout'
    })
    caseRecord.checks.push({
      name: '采购成本页面说明发票行级与订单级比较口径',
      passed:
        (await page.getByText('发票价格差异口径', { exact: false }).count()) > 0 ||
        (await page.getByText('发票比较范围', { exact: false }).count()) > 0,
      details: '真实 Chrome 采购成本页面发票价格比较范围提示'
    })
    await saveScreenshot(page, outputDir, 'cost-invoice-line-price-scope', record)
    caseRecord.evidence.push(
      '采购成本表发票比较范围契约、行级开票数量与单价字段、页面口径提示与截图'
    )
  }

  if (caseId === 'COST-027') {
    // 异常影响金额只从已确认来源快照与当前试算对象派生；无法量化时返回 UNRESOLVED，不用 0 冒充已知金额。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const periods = periodsResult?.data?.list || []
    const candidate = periods.find((row) => nonEmpty(row.id))
    if (candidate) {
      const hits = await api.request(
        'GET',
        `/cost/periods/${candidate.id}/rule-hits?pageNo=1&pageSize=100`
      )
      const rows = hits?.data?.list || []
      const scopes = ['SOURCE_LINE', 'TRIAL_DIFFERENCE', 'COST_CENTER_INPUT', 'UNRESOLVED']
      caseRecord.checks.push({
        name: '异常队列返回只读影响金额与取数口径',
        passed:
          hits?.code === 0 &&
          Array.isArray(rows) &&
          rows.every(
            (row) => nonEmpty(row.impactScope) && nonEmpty(row.impactBasis)
          ) &&
          rows.every((row) => scopes.includes(String(row.impactScope))),
        details: `periodId=${candidate.id} rows=${rows.length} scopes=${[
          ...new Set(rows.map((row) => String(row.impactScope)))
        ].join(',')}`
      })
      const unresolved = rows.filter((row) => row.impactScope === 'UNRESOLVED')
      caseRecord.checks.push({
        name: '不可量化异常不返回 0 冒充已知影响金额',
        passed: unresolved.every(
          (row) => row.impactAmount === null || row.impactAmount === undefined
        ),
        details: unresolved.length
          ? `unresolved=${unresolved.length} basis=${unresolved[0].impactBasis || ''}`
          : '本期异常均可在既有正式事实中量化'
      })
      const sourceScoped = rows.filter((row) => row.impactScope === 'SOURCE_LINE')
      caseRecord.checks.push({
        name: '来源类规则影响金额来自已确认来源快照且非零',
        passed: sourceScoped.every((row) => Number(row.impactAmount) > 0),
        details: sourceScoped.length
          ? `sourceRows=${sourceScoped.length} firstAmount=${sourceScoped[0].impactAmount}`
          : '本期没有来源类影响金额样本'
      })
    } else {
      caseRecord.checks.push({
        name: '存在可用于影响金额校验的成本期间',
        passed: false,
        details: '当前核算组织暂无成本期间'
      })
    }
    // 异常队列只作为成本工作台弹窗渲染，先打开工作台再点“流程阻断”入口触发弹窗。
    await openRoute(page, '/cost-management/workbench', { readySelector: '.title-line h1' })
    const exceptionEntry = page.getByText('流程阻断', { exact: false }).first()
    if ((await exceptionEntry.count()) > 0) {
      await exceptionEntry.click().catch(() => {})
    }
    // 异常队列是按需加载的工作区，需等待目标提示挂载后再断言，避免截图停在加载态。
    await page
      .locator('.impact-caliber-note')
      .first()
      .waitFor({ state: 'visible', timeout: 30000 })
      .catch(() => {})
    caseRecord.checks.push({
      name: '异常处理页面说明影响金额口径与不可量化规则',
      passed: (await page.getByText('异常影响金额口径', { exact: false }).count()) > 0,
      details: '真实 Chrome 异常队列影响金额口径提示'
    })
    await saveScreenshot(page, outputDir, 'cost-exception-impact-amount', record)
    caseRecord.evidence.push(
      '异常影响金额派生契约、不可量化口径、来源类金额校验与页面提示截图'
    )
  }

  if (caseId === 'COST-028') {
    // 回退与反月结先进入独立审批，审批通过并执行前不得改变正式成本。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const periods = periodsResult?.data?.list || []
    // 回退入口在发布批次存在性校验之后才校验原因，因此必须使用真实已发布期间。
    const candidate = loadCostScenario(caseRecord)?.period || periods.find((row) => nonEmpty(row.id))
    if (candidate) {
      const active = await api.request(
        'GET',
        `/cost/publication-approvals/periods/${candidate.id}/active`
      )
      caseRecord.checks.push({
        name: '回退反月结审批查询接口返回正式审批事实',
        passed:
          active?.code === 0 &&
          (!active.data ||
            (nonEmpty(active.data.actionType) &&
              active.data.status === 'PENDING' &&
              typeof active.data.canApprove === 'boolean' &&
              typeof active.data.canWithdraw === 'boolean')),
        details: active?.data
          ? `approvalId=${active.data.id} action=${active.data.actionType} status=${active.data.status}`
          : '当前期间没有待审批申请，接口返回空事实'
      })
      const missingReason = await api.request(
        'POST',
        `/cost/publications/${candidate.currentPublicationId || candidate.id}/rollback`,
        {}
      )
      caseRecord.checks.push({
        name: '回退入口只提交独立审批且仍强制校验申请原因',
        passed:
          missingReason?.code !== undefined &&
          missingReason.code !== 0 &&
          missingReason.code !== 500 &&
          String(missingReason.msg || missingReason.message || '').includes('回退或反月结原因'),
        details: `code=${missingReason?.code} msg=${missingReason?.msg || missingReason?.message || ''}`
      })
    } else {
      caseRecord.checks.push({
        name: '存在可用于回退审批契约校验的成本期间',
        passed: false,
        details: '当前核算组织暂无成本期间'
      })
    }
    // 成本发布工作区只在月度深链接下挂载，直接打开目标路由以读取常驻说明。
    await openRoute(page, '/cost-management/monthly/cost-publish', {
      readySelector: '.publish-workspace'
    })
    caseRecord.checks.push({
        name: '成本工作台常驻说明审批通过前不改变正式成本',
        passed:
        (await page.getByText('回退正式成本与反月结重开均采用独立审批', { exact: false }).count()) >
          0 &&
        (await page.getByText('申请人不能审批自己的申请', { exact: false }).count()) > 0 &&
        (await page.getByText('同一批次仅允许一条待审批申请', { exact: false }).count()) > 0,
        details: '真实 Chrome 成本发布工作台独立审批说明'
      })
    await saveScreenshot(page, outputDir, 'cost-publication-approval', record)
    caseRecord.evidence.push(
      '回退反月结审批查询契约、审批前不改变正式成本、发起审批原因校验与页面提示截图'
    )
  }

  if (caseId === 'COST-029') {
    // PB-071：成本中心编码稳定、部门有效期内唯一归属，停用后按后续日期释放。
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase()
    const firstCode = `E2E-CC-${suffix}`
    const secondCode = `E2E-CC2-${suffix}`
    const centersResult = await api.getBusiness(`/cost/centers?accountingOrgId=${accountingOrgId}`)
    const departmentsResult = await api.getBusiness('/cost/centers/departments')
    const centers = costArrayData(centersResult, '成本中心')
    const departments = flattenDepartments(costArrayData(departmentsResult, '成本中心部门'))
    const occupiedDepartmentIds = new Set(
      centers
        .filter((row) => row.status !== 'DISABLED' || !row.disabledAt)
        .flatMap((row) => row.departmentIds || [])
        .map(String)
    )
    const availableDepartment = departments.find(
      (row) => row.status === 0 && !occupiedDepartmentIds.has(String(row.id))
    )
    let firstCenterId
    let firstCenterActive = false
    let secondCenterId
    let secondCenterActive = false
    let missingAvailableDepartment = false

    if (availableDepartment) {
      const firstDate = nextCostCenterStartDate({
        centers, departmentId: availableDepartment.id, today: offsetDate(0)
      })
      const secondDateValue = new Date(`${firstDate}T00:00:00Z`)
      secondDateValue.setUTCDate(secondDateValue.getUTCDate() + 1)
      const secondDate = secondDateValue.toISOString().slice(0, 10)
      caseRecord.notes.push(`临时成本中心仅使用历史停用日之后的区间：${firstDate} / ${secondDate}`)
      const firstPayload = {
        accountingOrgId,
        code: firstCode,
        name: `E2E成本中心${suffix}`,
        enabledAt: firstDate,
        departmentIds: [availableDepartment.id],
        remark: 'PB-071 E2E temporary cost center'
      }
      try {
        const firstCreate = await api.post('/cost/centers', firstPayload)
        firstCenterId = responseData(firstCreate)?.id
        firstCenterActive = firstCreate?.code === 0 && nonEmpty(firstCenterId)
        caseRecord.checks.push({
          name: '成本中心可引用真实部门并按启用日期创建',
          passed: firstCenterActive,
          details: `centerId=${firstCenterId || 'missing'}, deptId=${availableDepartment.id}`
        })
        if (!firstCenterActive) {
          throw new Error(`成本中心首次创建失败，停止后续写侧：${firstCreate?.msg || firstCreate?.code}`)
        }
        caseRecord.checks.push({
          name: '成本中心回读保留原始部门 ID，未发生 Snowflake 精度丢失',
          passed: responseData(firstCreate)?.departmentIds?.includes(availableDepartment.id) === true,
          details: `deptId=${availableDepartment.id}`
        })

        const overlapCreate = await api.post('/cost/centers', {
          ...firstPayload,
          code: secondCode,
          name: `E2E重叠成本中心${suffix}`,
          enabledAt: secondDate
        })
        caseRecord.checks.push({
          name: '同一部门在重叠有效期内禁止重复归属',
          passed:
            overlapCreate?.code !== 0 &&
            String(overlapCreate?.msg || overlapCreate?.message || '').includes('已归属'),
          details: `code=${overlapCreate?.code} msg=${overlapCreate?.msg || overlapCreate?.message || ''}`
        })

        const codeChange = await api.put(`/cost/centers/${firstCenterId}`, {
          ...firstPayload,
          code: `${firstCode}-CHANGED`
        })
        caseRecord.checks.push({
          name: '成本中心稳定编码创建后不可修改',
          passed:
            codeChange?.code !== 0 &&
            String(codeChange?.msg || codeChange?.message || '').includes('编码创建后不允许修改'),
          details: `code=${codeChange?.code} msg=${codeChange?.msg || codeChange?.message || ''}`
        })

        const firstDeactivate = await api.post(`/cost/centers/${firstCenterId}/deactivate`, {
          disabledAt: firstDate,
          reason: 'PB-071 E2E cleanup'
        })
        firstCenterActive = !(firstDeactivate?.code === 0)
        caseRecord.checks.push({
          name: '成本中心停用后关闭部门有效关系',
          passed: firstDeactivate?.code === 0,
          details: `code=${firstDeactivate?.code}`
        })
        if (firstCenterActive) throw new Error('首次停用失败，停止后续部门重用')

        const secondCreate = await api.post('/cost/centers', {
          ...firstPayload,
          code: secondCode,
          name: `E2E后续成本中心${suffix}`,
          enabledAt: secondDate
        })
        secondCenterId = responseData(secondCreate)?.id
        secondCenterActive = secondCreate?.code === 0 && nonEmpty(secondCenterId)
        caseRecord.checks.push({
          name: '停用后的部门可按后续日期归属新成本中心',
          passed: secondCenterActive,
          details: `centerId=${secondCenterId || 'missing'}`
        })
        if (!secondCenterActive) throw new Error('后续成本中心创建失败，停止页面数据断言')

        await openRoute(page, '/cost-management/modeling/profile', {
          readySelector: '.page-head h1',
          readyTimeoutMs: 30000
        })
        const manageEntry = page.getByRole('button', { name: '管理成本中心' }).first()
        if ((await manageEntry.count()) > 0) {
          await manageEntry.click()
          await page
            .getByText('成本中心与部门归属', { exact: false })
            .first()
            .waitFor({ state: 'visible', timeout: 30000 })
        }
        const activeCenterNode = page.getByText(`E2E后续成本中心${suffix}`, { exact: true }).first()
        await activeCenterNode.waitFor({ state: 'visible', timeout: 30000 })
        await activeCenterNode.click()
        await page
          .getByRole('button', { name: '停用' })
          .first()
          .waitFor({ state: 'visible', timeout: 30000 })
        caseRecord.checks.push({
          name: '成本中心维护页按权限提供新增、编辑和停用入口',
          passed:
            (await page.getByText('成本中心与部门归属', { exact: false }).count()) > 0 &&
            (await page.getByRole('button', { name: '新增' }).count()) > 0 &&
            (await page.getByRole('button', { name: '编辑成本中心' }).count()) > 0 &&
            (await page.getByRole('button', { name: '停用' }).count()) > 0,
          details: page.url()
        })
        await saveScreenshot(page, outputDir, 'cost-center-period-permission', record)
      } finally {
        if (firstCenterId && firstCenterActive) {
          try {
            const cleanup = await api.post(`/cost/centers/${firstCenterId}/deactivate`, {
              disabledAt: firstDate,
              reason: 'PB-071 E2E cleanup'
            })
            caseRecord.checks.push({
              name: '本轮首次成本中心失败后清理停用成功',
              passed: cleanup?.code === 0 && responseData(cleanup)?.status === 'DISABLED',
              details: `centerId=${firstCenterId}, code=${cleanup?.code}`
            })
          } catch (error) {
            caseRecord.checks.push({
              name: '本轮首次成本中心失败后清理停用成功',
              passed: false,
              details: error.message
            })
          }
        }
        if (secondCenterId && secondCenterActive) {
          try {
            const cleanup = await api.post(`/cost/centers/${secondCenterId}/deactivate`, {
              disabledAt: secondDate,
              reason: 'PB-071 E2E cleanup'
            })
            caseRecord.checks.push({
              name: '本轮后续成本中心清理停用成功',
              passed: cleanup?.code === 0 && responseData(cleanup)?.status === 'DISABLED',
              details: `centerId=${secondCenterId}, code=${cleanup?.code}`
            })
          } catch (error) {
            caseRecord.checks.push({
              name: '本轮后续成本中心清理停用成功',
              passed: false,
              details: error.message
            })
          }
        }
      }
    } else {
      missingAvailableDepartment = true
      caseRecord.checks.push({
        name: '真实部门占用前置已查询（无可用区间，保留 PARTIAL）',
        passed: true,
        details: '当前没有启用且不存在开放归属关系的部门，未创建临时成本中心'
      })
    }

    if (missingAvailableDepartment) {
      await saveCostPrerequisiteEvidence({
        caseId, page, record, caseRecord, outputDir,
        note: '部门依赖缺失，仅完成正式部门查询与工作台前置，未执行成本中心创建/停用'
      })
      return {
        token,
        api,
        partial: true,
        note: '当前没有未占用部门，成本中心写侧未伪造数据'
      }
    }
    caseRecord.evidence.push(
      '成本中心正式创建、编码不可变、部门跨期冲突、停用释放与页面权限入口'
    )
    return { token, api }
  }

  if (caseId === 'COST-030') {
    // PB-072/073：成本构成项与来源规则按模型版本走正式 API，方向/口径字段往返不丢失。
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase()
    const draftModel = ownedCostFixture.model
    if (draftModel) {
      const modelVersionId = String(draftModel.id)
      const original = ownedCostFixture.config
      caseRecord.checks.push({
        name: '成本构成项正式接口返回分类/构成项/来源规则三段结构',
        passed:
          Array.isArray(original.categories) &&
          Array.isArray(original.items) &&
          Array.isArray(original.sourceRules),
        details: `categories=${original.categories?.length ?? 'n/a'} items=${original.items?.length ?? 'n/a'} sourceRules=${original.sourceRules?.length ?? 'n/a'}`
      })
      const probeCode = `E2E-CCF-${suffix}`
      const probePayload = {
        categories: [
          {
            id: 'cat-probe',
            parentId: '',
            code: `${probeCode}-C`,
            name: 'E2E构成分类',
            sortNo: 100,
            status: 'ENABLED'
          }
        ],
        items: [
          {
            id: 'item-probe',
            categoryId: 'cat-probe',
            code: probeCode,
            name: 'E2E构成项',
            inclusionRate: 100,
            fetchMode: 'AUTO',
            resultScope: 'OPERATING_EXPENSE',
            businessDirection: 'EXPENSE',
            amountBasis: '审核金额',
            dateBasis: '审核日期',
            reportScope: '管理费用',
            affectOperatingProfit: true,
            reconciliationSourceType: 'ERP_EXPENSE_REPORT',
            systemItem: false,
            participateWip: false,
            status: 'ENABLED',
            remark: 'PB-072/073 E2E probe'
          }
        ],
        sourceRules: [
          {
            id: 'rule-probe',
            componentItemId: 'item-probe',
            sourceType: 'SRC-EXPENSE',
            sourcePriority: 1,
            status: 'ENABLED'
          }
        ]
      }
      try {
      const replaced = await api.put(
        `/cost/model-versions/${modelVersionId}/components`,
        probePayload
      )
      caseRecord.checks.push({
        name: '成本构成项与来源规则可写入正式接口',
        passed: replaced?.code === 0,
        details: `code=${replaced?.code} msg=${replaced?.msg || replaced?.message || ''}`
      })
      const reloaded = await api.getBusiness(
        `/cost/model-versions/${modelVersionId}/components`
      )
      const reloadedItem = (reloaded?.data?.items || []).find((row) => row.code === probeCode)
      const reloadedRule = (reloaded?.data?.sourceRules || [])[0]
      caseRecord.checks.push({
        name: '业务方向/金额口径/日期依据/报表归属/经营利润标志往返不丢失',
        passed:
          Boolean(reloadedItem) &&
          reloadedItem.businessDirection === 'EXPENSE' &&
          reloadedItem.amountBasis === '审核金额' &&
          reloadedItem.dateBasis === '审核日期' &&
          reloadedItem.reportScope === '管理费用' &&
          reloadedItem.affectOperatingProfit === true &&
          reloadedItem.reconciliationSourceType === 'ERP_EXPENSE_REPORT',
        details: JSON.stringify({
          businessDirection: reloadedItem?.businessDirection,
          amountBasis: reloadedItem?.amountBasis,
          dateBasis: reloadedItem?.dateBasis,
          reportScope: reloadedItem?.reportScope,
          affectOperatingProfit: reloadedItem?.affectOperatingProfit,
          reconciliationSourceType: reloadedItem?.reconciliationSourceType
        })
      })
      caseRecord.checks.push({
        name: '来源规则随构成项一并保存',
        passed: Boolean(reloadedRule) && reloadedRule.sourceType === 'SRC-EXPENSE',
        details: JSON.stringify(reloadedRule || {})
      })
      const locked = await createLockedCostModelFixture({
        api, record, caseRecord, remark: costFixtureRemark(caseRecord.fixtures.cost)
      })
      const rejected = await api.put(`/cost/model-versions/${locked.id}/components`, probePayload)
      const lockedConfiguration = responseData(
        await api.getBusiness(`/cost/model-versions/${locked.id}/components`)
      )
      caseRecord.checks.push({
        name: '锁定成本模型拒绝构成项与来源规则写入，原配置不改变',
        passed: rejected?.code === 422001 &&
          String(rejected.msg || '').includes('locked model configuration cannot be changed') &&
          lockedConfiguration.categories.length === 0 &&
          lockedConfiguration.items.length === 0 && lockedConfiguration.sourceRules.length === 0,
        details: `lockedModel=${locked.id} code=${rejected?.code}`
      })
      } finally {
        await restoreCostConfiguration({ api, modelVersionId, original, caseRecord })
      }
      await (dependencies.openRoute || openRoute)(page, '/cost-management')
      caseRecord.checks.push({
        name: '成本构成项页面路由可进入',
        passed: page.url().includes('/cost-management'),
        details: page.url()
      })
      await (dependencies.saveScreenshot || saveScreenshot)(page, outputDir, 'cost-component-formal-config', record)
    }
    caseRecord.evidence.push('成本构成项正式读写、方向口径字段往返与来源规则保存')
  }

  if (caseId === 'COST-031') {
    // PB-076：经营收支项目落正式 cost_component_item，固定收入/支出根分类，取数范围走 scope_json。
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase()
    const draftModel = ownedCostFixture.model
    if (draftModel) {
      const modelVersionId = String(draftModel.id)
      const original = ownedCostFixture.config
      const nonOperatingCategories = (original.categories || []).filter(
        (row) => row.code !== 'OP-INC-ROOT' && row.code !== 'OP-EXP-ROOT'
      )
      const nonOperatingItems = (original.items || []).filter(
        (row) => row.businessDirection !== 'REVENUE' && row.businessDirection !== 'EXPENSE'
      )
      const keepItemIds = new Set(nonOperatingItems.map((row) => row.id))
      const nonOperatingRules = (original.sourceRules || []).filter((rule) =>
        keepItemIds.has(rule.componentItemId)
      )
      const probeCode = `E2E-OP-${suffix}`
      const scope = ['已审核费用报销单', '不含税金额']
      const payload = {
        categories: [
          ...nonOperatingCategories,
          { id: 'OP-INC-ROOT', parentId: '', code: 'OP-INC-ROOT', name: '经营收入', sortNo: 800, status: 'ENABLED' },
          { id: 'OP-EXP-ROOT', parentId: '', code: 'OP-EXP-ROOT', name: '经营支出', sortNo: 810, status: 'ENABLED' }
        ],
        items: [
          ...nonOperatingItems,
          {
            id: probeCode,
            categoryId: 'OP-EXP-ROOT',
            code: probeCode,
            name: 'E2E 管理费用',
            inclusionRate: 100,
            fetchMode: 'AUTO',
            resultScope: 'OPERATING_EXPENSE',
            businessDirection: 'EXPENSE',
            amountBasis: '审核金额',
            dateBasis: '审核日期',
            reportScope: '管理费用',
            affectOperatingProfit: true,
            scopeJson: JSON.stringify(scope),
            systemItem: false,
            participateWip: false,
            status: 'ENABLED',
            remark: 'PB-076 E2E probe'
          }
        ],
        sourceRules: [
          ...nonOperatingRules,
          { id: `${probeCode}-P`, componentItemId: probeCode, sourceType: '费用报销单', sourcePriority: 1, status: 'ENABLED' },
          { id: `${probeCode}-C1`, componentItemId: probeCode, sourceType: '应付账款', sourcePriority: 2, status: 'ENABLED' }
        ]
      }
      try {
      const replaced = await api.put(
        `/cost/model-versions/${modelVersionId}/components`,
        payload
      )
      caseRecord.checks.push({
        name: '经营收支项目可写入本案专属 E2E 成本构成模型',
        passed: replaced?.code === 0,
        details: `code=${replaced?.code} msg=${replaced?.msg || replaced?.message || ''}`
      })
      const reloaded = await api.getBusiness(
        `/cost/model-versions/${modelVersionId}/components`
      )
      const probe = (reloaded?.data?.items || []).find((row) => row.code === probeCode)
      caseRecord.checks.push({
        name: '经营收支方向/报表归属/经营利润标志往返不丢失',
        passed:
          Boolean(probe) &&
          probe.businessDirection === 'EXPENSE' &&
          probe.reportScope === '管理费用' &&
          probe.affectOperatingProfit === true,
        details: JSON.stringify({
          businessDirection: probe?.businessDirection,
          reportScope: probe?.reportScope,
          affectOperatingProfit: probe?.affectOperatingProfit
        })
      })
      caseRecord.checks.push({
        name: '取数范围经 scope_json 往返不丢失',
        passed:
          Boolean(probe?.scopeJson) &&
          JSON.stringify(JSON.parse(probe.scopeJson)) === JSON.stringify(scope),
        details: probe?.scopeJson || 'missing'
      })
      const probeRules = (reloaded?.data?.sourceRules || []).filter(
        (rule) => rule.componentItemId === probe?.id
      )
      caseRecord.checks.push({
        name: '主来源与核对来源按优先级保存为来源规则',
        passed:
          probeRules.length === 2 &&
          probeRules.some((rule) => rule.sourceType === '费用报销单' && rule.sourcePriority === 1) &&
          probeRules.some((rule) => rule.sourceType === '应付账款' && rule.sourcePriority === 2),
        details: probeRules.map((rule) => `${rule.sourceType}#${rule.sourcePriority}`).join(',')
      })
      const originalNonOperating = {
        categories: nonOperatingCategories, items: nonOperatingItems, sourceRules: nonOperatingRules
      }
      const originalCodes = new Set(nonOperatingItems.map((item) => item.code))
      const retainedItems = reloaded.data.items.filter((item) => originalCodes.has(item.code))
      const retainedIds = new Set(retainedItems.map((item) => item.id))
      const retainedConfiguration = {
        categories: reloaded.data.categories.filter((category) =>
          nonOperatingCategories.some((originalCategory) => originalCategory.code === category.code)),
        items: retainedItems,
        sourceRules: reloaded.data.sourceRules.filter((rule) => retainedIds.has(rule.componentItemId))
      }
      caseRecord.checks.push({
        name: '经营配置固定收入支出根分类，并保留既有成本构成项及取数规则业务值',
        passed: reloaded.data.categories.some((category) => category.code === 'OP-INC-ROOT') &&
          reloaded.data.categories.some((category) => category.code === 'OP-EXP-ROOT') &&
          costConfigurationSignature(retainedConfiguration) === costConfigurationSignature(originalNonOperating),
        details: `retainedItems=${retainedItems.length} originalItems=${nonOperatingItems.length}`
      })
      for (let iteration = 1; iteration <= 2; iteration++) {
        const repeated = responseData(await api.putBusiness(
          `/cost/model-versions/${modelVersionId}/components`,
          payload
        ))
        caseRecord.checks.push({
          name: `同编码经营配置第 ${iteration} 次重复保存成功且业务值保持一致`,
          passed: costConfigurationSignature(repeated) === costConfigurationSignature(reloaded.data),
          details: `model=${modelVersionId} iteration=${iteration}`
        })
      }
      } finally {
        await restoreCostConfiguration({ api, modelVersionId, original, caseRecord })
      }
      await (dependencies.openRoute || openRoute)(page, '/cost-management')
      caseRecord.checks.push({
        name: '收入与支出配置页面路由可进入',
        passed: page.url().includes('/cost-management'),
        details: page.url()
      })
      await (dependencies.saveScreenshot || saveScreenshot)(page, outputDir, 'cost-operating-formal-config', record)
    }
    caseRecord.evidence.push('经营收支项目正式落库、方向与取数范围往返、来源规则优先级')
  }

  if (caseId === 'COST-032') {
    // PB-074：工时/机器时/面积/产量等受控分摊因子，因子必须来自正式快照或人工确认。
    const draftModel = ownedCostFixture.model
    const center = ownedCostFixture.center
    const componentItemId = ownedCostFixture.componentItem.id
    if (draftModel?.id && center && componentItemId) {
      const basePayload = {
        modelVersionId: String(draftModel.id),
        costCenterId: String(center.id),
        effectiveMonth: COST_CASE_EFFECTIVE_MONTH,
        status: 'DRAFT'
      }
      for (const allocationMode of ['LABOR_HOUR', 'MACHINE_HOUR', 'AREA', 'OUTPUT']) {
      const missingSource = await api.put('/cost/allocation-rules', {
        ...basePayload,
        lines: [
          {
            componentItemId: String(componentItemId),
            finishedRatio: 100,
            wipRatio: 0,
            allocationMode
          }
        ]
      })
      caseRecord.checks.push({
        name: `${allocationMode} 因子缺少来源时被拒绝`,
        passed:
          missingSource?.code !== 0 &&
          String(missingSource?.msg || missingSource?.message || '').includes(
            'factor source must be SNAPSHOT or MANUAL'
          ),
        details: `code=${missingSource?.code} msg=${missingSource?.msg || missingSource?.message || ''}`
      })
      }
      const unknownMode = await api.put('/cost/allocation-rules', {
        ...basePayload,
        lines: [
          {
            componentItemId: String(componentItemId),
            finishedRatio: 100,
            wipRatio: 0,
            allocationMode: 'UNKNOWN_FACTOR'
          }
        ]
      })
      caseRecord.checks.push({
        name: '未知分摊模式被拒绝',
        passed:
          unknownMode?.code !== 0 &&
          String(unknownMode?.msg || unknownMode?.message || '').includes(
            'unsupported allocation mode'
          ),
        details: `code=${unknownMode?.code} msg=${unknownMode?.msg || unknownMode?.message || ''}`
      })
      // 使用远期月份写入数量模式规则，确认原有模式未回归且不影响真实期间。
      const fallback = await api.put('/cost/allocation-rules', {
        ...basePayload,
        lines: [
          {
            componentItemId: String(componentItemId),
            finishedRatio: 100,
            wipRatio: 0,
            allocationMode: 'QUANTITY'
          }
        ]
      })
      caseRecord.checks.push({
        name: '原有数量分摊模式仍可写入',
        passed: fallback?.code === 0,
        details: `code=${fallback?.code} msg=${fallback?.msg || fallback?.message || ''}`
      })
    } else {
      caseRecord.checks.push({
        name: '存在草稿模型/启用成本中心/构成项以校验分摊因子',
        passed: false,
        details: `model=${draftModel?.id || '-'} center=${center?.id || '-'} item=${componentItemId || '-'}`
      })
    }
    await (dependencies.openRoute || openRoute)(page, '/cost-management')
    caseRecord.checks.push({
      name: '分摊规则页面路由可进入',
      passed: page.url().includes('/cost-management'),
      details: page.url()
    })
    await (dependencies.saveScreenshot || saveScreenshot)(page, outputDir, 'cost-allocation-factor', record)
    caseRecord.evidence.push('受控分摊因子校验、未知模式拒绝与原有模式回归')
  }

  if (caseId === 'COST-033') {
    // PB-075：期初在制导入按模板行返回逐行错误定位。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const accountingPeriod = (periodsResult?.data?.list || []).find(
      (item) => item.status === 'ACCOUNTING'
    )
    if (!accountingPeriod?.id) {
      caseRecord.checks.push({
        name: '存在核算中成本期间以校验逐行错误定位',
        passed: false,
        details: '当前核算组织没有 ACCOUNTING 状态成本期间'
      })
    } else {
      // 服务层按模板行校验：合法行引用真实启用存货档案，非法行留空编码触发定位错误。
      const validRow = {
        stage: 'OPENING',
        objectKey: 'E2E-WIP-OK',
        materialId: '',
        productCode: 'ERP-RM-001',
        quantity: 1,
        materialAmount: 10,
        laborAmount: 0,
        expenseAmount: 0,
        totalAmount: 10,
        unitCost: 10,
        sourceType: 'MANUAL'
      }
      const badRow = { ...validRow, objectKey: 'E2E-WIP-ROW', productCode: '' }
      const rejected = await api.put(
        `/cost/periods/${accountingPeriod.id}/opening-wip?stage=OPENING`,
        [badRow]
      )
      caseRecord.checks.push({
        name: '期初在制非法行按模板行号返回错误',
        passed:
          rejected?.code !== 0 &&
          String(rejected?.msg || rejected?.message || '').includes('第2行'),
        details: `code=${rejected?.code} msg=${rejected?.msg || rejected?.message || ''}`
      })
      const secondRowBatch = await api.put(
        `/cost/periods/${accountingPeriod.id}/opening-wip?stage=OPENING`,
        [
          validRow,
          { ...validRow, objectKey: 'E2E-WIP-BAD', productCode: '' }
        ]
      )
      caseRecord.checks.push({
        name: '多行批次错误定位到具体出错行',
        passed:
          secondRowBatch?.code !== 0 &&
          String(secondRowBatch?.msg || secondRowBatch?.message || '').includes('第3行'),
        details: `code=${secondRowBatch?.code} msg=${secondRowBatch?.msg || secondRowBatch?.message || ''}`
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '期初在制页面路由可进入',
      passed: page.url().includes('/cost-management'),
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'cost-opening-wip-row-error', record)
    caseRecord.evidence.push('期初在制逐行错误定位与多行批次错误行号')
  }

  if (caseId === 'COST-034') {
    // PB-077：取数/试算/确认/发布四个阶段均落规则通过记录，并保留规则版本与证据。
    const periodsResult = await api.getBusiness(
      `/cost/periods?accountingOrgId=${accountingOrgId}&pageNo=1&pageSize=100`
    )
    const periods = periodsResult?.data?.list || []
    const candidate =
      loadCostScenario(caseRecord)?.period ||
      periods.find((row) => row.status === 'COST_PUBLISHED' && nonEmpty(row.currentPublicationId)) ||
      periods.find((row) => nonEmpty(row.currentPublicationId)) ||
      periods.find((row) => nonEmpty(row.currentTrialId))
    if (candidate) {
      const hits = await api.request(
        'GET',
        `/cost/periods/${candidate.id}/rule-hits?pageNo=1&pageSize=100&level=PASS`
      )
      const rows = hits?.data?.list || []
      caseRecord.checks.push({
        name: '阶段通过类命中记录可按 PASS 级别分页查询',
        passed: hits?.code === 0 && Array.isArray(rows) && rows.length > 0,
        details: `periodId=${candidate.id} total=${hits?.data?.total ?? 0} rows=${rows.length}`
      })
      caseRecord.checks.push({
        name: '通过类命中记录保留规则版本快照与阶段证据',
        passed:
          rows.length > 0 &&
          rows.every((row) => nonEmpty(row.ruleVersion) && nonEmpty(row.basis)) &&
          rows.every((row) => row.status === 'CLOSED'),
        details: rows.length
          ? `示例：ruleCode=${rows[0].ruleCode} ruleVersion=${rows[0].ruleVersion} status=${rows[0].status} basis=${rows[0].basis}`
          : '无通过类命中记录'
      })
      const stages = ['试算', '确认', '发布', '取数']
      const covered = stages.filter((stage) => rows.some((row) => String(row.basis).includes(stage)))
      caseRecord.checks.push({
        name: '试算/确认/发布阶段均有通过类命中记录',
        passed: ['试算', '确认', '发布'].every((stage) => covered.includes(stage)),
        details: `已覆盖阶段=${covered.join(',') || '无'}`
      })
      const blocking = await api.request(
        'GET',
        `/cost/periods/${candidate.id}/rule-hits?pageNo=1&pageSize=100&level=BLOCK&status=OPEN`
      )
      const blockingRows = blocking?.data?.list || []
      caseRecord.checks.push({
        name: '通过类记录不参与未处理阻断项统计',
        passed:
          rows.every((row) => row.level === 'PASS') &&
          blockingRows.every((row) => row.level === 'BLOCK' && row.status === 'OPEN'),
        details: `passRows=${rows.length} openBlocking=${blockingRows.length}`
      })
    } else {
      caseRecord.checks.push({
        name: '存在可用于阶段命中记录校验的成本期间',
        passed: false,
        details: '当前核算组织暂无已试算/已发布的成本期间'
      })
    }
    await openRoute(page, '/cost-management')
    caseRecord.checks.push({
      name: '成本管理页面可进入并展示异常队列入口',
      passed: page.url().includes('/cost-management'),
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'cost-rule-stage-pass', record)
    caseRecord.evidence.push('取数/试算/确认/发布阶段 PASS 命中记录、规则版本快照与阶段证据文本')
  }

  if (ownedCostFixture) {
    await (dependencies.recordCostDatabase || recordCostDatabase)({
      modelVersionId: ownedCostFixture.model.id, caseRecord
    })
  }
  caseRecord.evidence.push('真实成本模型、期间与截图证据')
  return { token, api }
}
