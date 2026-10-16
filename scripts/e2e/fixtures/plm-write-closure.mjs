import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { config } from '../config/index.mjs'
import { createApiClient, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { assertBusinessSuccess, isBusinessSuccess } from '../lib/assertions.mjs'
import { assertLocalWriteSafety } from '../lib/db.mjs'

export const PLM_ASSERTIONS = Object.freeze({
  'PLM-001': ['项目阶段完整', '产品/BOM/工艺版本可追溯', '成员权限隔离', '不复制知识正文'],
  'PLM-002': ['发布前业务单据不可使用', '正式发布后通过 API 提供给 ERP/MES', '重复发布幂等', '版本和来源保留']
})

export const PLM_REVERSE_ASSERTIONS = Object.freeze({
  'PLM-001': ['草稿模型可撤回，已发布模型使用新版本'],
  'PLM-002': ['已消费版本不得物理删除，使用失效/新版本']
})

export const PLM_STAGES = Object.freeze([
  'INIT', 'DESIGN', 'EXPERIMENT', 'PILOT_SCALE', 'INSPECTION',
  'PILOT', 'MASS', 'CLOSED_LOOP', 'FINISHED'
])

// These are source-confirmed contract gaps, not evidence of passing business behavior.
export const PLM_CONTRACT_GAPS = Object.freeze({
  association: 'PLM 项目只保存 extraJson，未提供受控 PMS 项目关联 API；pmsProjectId 扩展元数据不等于正式领域关联。',
  version: '产品无显式版本/父件版本关联写入口；基线 DO 无 versionNo，详情未回填；PROCESS create 每次新建路线、update 原地改版本，没有同路线新版本写入口。',
  baseline: 'PlmCoreBaselineController 没有 create/save 接口，现有产品/零件/EBOM 写接口也不生成基线；不能用共享基线或 SQL 假造专属发布样本。',
  knowledge: 'PLM 未暴露知识中枢文档关联/版本/权限校验 API；扩展 JSON 中的引用可回读，但不能证明正式知识引用契约及服务端正文不复制。',
  consumption: 'EBOM 下发仅生成 MES BOM 草稿；RDM release-to-mes 可下发启用 BOM/路线，但不是 core 基线发布或 ERP 消费；计划保存/用料展开不等于工单消费，不将 dryRun/check/人工补写回执算作消费。',
  history: 'downstream-refs 当前返回空列表；生产 BOM 按项目/物料更新主档，尚缺已消费版本删除保护及同路线新版本历史闭环。',
  approval: 'RECIPE/PROCESS record/update 可直接写 RELEASED 状态；本轮状态夹具不等于 BPM 审批通过，未证明审批不可绕过。',
  withdrawal: '正式 record 接口只有 create/update/delete/start-approval；没有草稿模型撤回入口，不将 delete、改写状态或项目 transition-status 当撤回。'
})

const dataOf = (response) => assertBusinessSuccess(response, 'PLM fixture API').data
const query = (values) => new URLSearchParams(values).toString()
const fact = (record, name, passed, details = '') => {
  record.checks.push({ name, passed: passed === true, details: typeof details === 'string' ? details : JSON.stringify(details) })
  return passed === true
}
const requireFact = (record, name, passed, details) => {
  if (!fact(record, name, passed, details)) throw new Error(`PLM 夹具所有权或写入回读失败：${name}`)
}

export const plmId = (value, label) => {
  const id = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : ''
  if (!/^[1-9]\d*$/.test(id) || BigInt(id) > 9223372036854775807n) {
    throw new Error(`BLOCKED: ${label} 未返回精确的正整数数据库 ID`)
  }
  return id
}

export const plmRows = (response) => {
  const data = dataOf(response)
  const rows = Array.isArray(data) ? data : data?.list ?? data?.records
  if (!Array.isArray(rows) || rows.some((row) =>
    !row || typeof row !== 'object' || Array.isArray(row) || !Object.keys(row).length)) {
    throw new Error('PLM 写侧回读不是有效对象数组')
  }
  return rows
}

export function assertPlmLocalTarget (runtime = config) {
  if (runtime.target !== 'local' || runtime.tenantName !== 'CFOR 标准平台') {
    throw new Error('BLOCKED: PLM 专属写侧只允许本地 CFOR 标准平台租户')
  }
  for (const [value, port] of [[runtime.apiBase, '48083'], [runtime.webBase, '9151']]) {
    const url = new URL(value)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.protocol !== 'http:' || url.port !== port) {
      throw new Error('BLOCKED: PLM 专属写侧地址必须是本地 48083/9151')
    }
  }
  if (String(runtime.tenantId) !== '1') {
    throw new Error('BLOCKED: PLM 写侧必须先确认 CFOR 标准平台的真实 tenantId=1')
  }
  if (runtime.apiUrl && new URL(runtime.apiUrl).origin !== new URL(runtime.apiBase).origin) {
    throw new Error('BLOCKED: PLM API 前缀不得指向其他服务')
  }
}

export function initializePlmAssertions (caseRecord, caseId) {
  if (!PLM_ASSERTIONS[caseId]) throw new Error(`Unsupported PLM case: ${caseId}`)
  caseRecord.catalogAssertions = PLM_ASSERTIONS[caseId].map((assertion, index) => ({
    index, assertion, status: 'GAP', evidenceChecks: [], details: '尚未执行真实写侧验证'
  }))
  caseRecord.reverseAssertions = PLM_REVERSE_ASSERTIONS[caseId].map((assertion, index) => ({
    index, assertion, status: 'GAP', evidenceChecks: [],
    details: caseId === 'PLM-001' ? `${PLM_CONTRACT_GAPS.withdrawal} ${PLM_CONTRACT_GAPS.version}` : PLM_CONTRACT_GAPS.history
  }))
}

export function markPlmAssertion (caseRecord, index, names, gap = '') {
  const row = caseRecord.catalogAssertions[index]
  row.evidenceChecks = [...names]
  row.details = gap
}

export function finalizePlmAssertions (caseRecord) {
  for (const row of [...caseRecord.catalogAssertions, ...(caseRecord.reverseAssertions || [])]) {
    const checks = row.evidenceChecks.flatMap((name) => caseRecord.checks.filter((check) => check.name === name))
    const missing = row.evidenceChecks.filter((name) => !caseRecord.checks.some((check) => check.name === name))
    row.status = !row.details && row.evidenceChecks.length > 0 && !missing.length &&
      checks.every((check) => check.passed === true) ? 'VERIFIED' : 'GAP'
    if (row.status === 'GAP') {
      const reason = row.details || `缺失或失败检查：${[...missing,
        ...checks.filter((check) => check.passed !== true).map((check) => check.name)].join(', ') || '无结构化证据'}`
      const note = `${caseRecord.id || 'PLM'} ${row.assertion}：${reason}`
      if (!caseRecord.notes.includes(note)) caseRecord.notes.push(note)
    }
  }
  caseRecord.remainingAssertions = caseRecord.catalogAssertions.filter((row) =>
    row.status !== 'VERIFIED').map((row) => row.assertion)
  caseRecord.remainingReverseAssertions = (caseRecord.reverseAssertions || []).filter((row) =>
    row.status !== 'VERIFIED').map((row) => row.assertion)
  caseRecord.catalogComplete = caseRecord.catalogAssertions.length > 0 &&
    caseRecord.remainingAssertions.length === 0 && caseRecord.remainingReverseAssertions.length === 0
  return {
    partial: !caseRecord.catalogComplete,
    acceptanceComplete: caseRecord.catalogComplete &&
      caseRecord.checks.length > 0 && caseRecord.checks.every((check) => check.passed === true),
    note: caseRecord.notes.join('；')
  }
}

export function createPlmKnowledgeApi ({ token, tenantId, record, apiFactory = createApiClient }) {
  const audit = { api: [] }
  const client = apiFactory({ token, tenantId, record: audit })
  return {
    async getBusiness (path) {
      if (path !== '/ai/knowledge/document/page?pageNo=1&pageSize=100&status=0') {
        throw new Error('PLM 知识引用只允许读取文档分页标识')
      }
      try {
        const response = await client.getBusiness(path)
        return { ...response, data: plmRows(response).map((row) => ({
          id: row.id, knowledgeId: row.knowledgeId
        })) }
      } catch {
        // Do not propagate an API error that might embed the document response body.
        throw new Error('PLM 知识文档列表读取失败，响应正文已省略')
      } finally {
        for (const entry of audit.api.splice(0)) {
          record?.api?.push({ ...entry, bodySummary: '知识文档响应正文已省略，仅使用文档 ID 与知识库 ID' })
        }
      }
    }
  }
}

export async function expectPlmRejection ({ api, method, path, body, expected, caseRecord, name }) {
  const response = await api.request(method, path, body, { expectedBusinessRejection: expected })
  const passed = matchesExpectedBusinessRejection(response, expected)
  fact(caseRecord, name, passed, { path, code: response?.code,
    message: response?.msg || response?.message, unexpectedlyAccepted: isBusinessSuccess(response) })
  return { passed, response }
}

export async function createPlmModel ({ api, caseRecord, runtime = config,
  writeSafety = assertLocalWriteSafety, tokenFactory = () => randomBytes(6).toString('hex') }) {
  assertPlmLocalTarget(runtime)
  await writeSafety(caseRecord)
  const resolvedTenant = plmId(dataOf(await api.getBusiness(
    `/system/tenant/get-id-by-name?name=${encodeURIComponent(runtime.tenantName)}`)), '租户')
  if (resolvedTenant !== String(runtime.tenantId)) throw new Error('BLOCKED: PLM 租户名称与令牌目标不一致')
  const profile = dataOf(await api.getBusiness('/system/user/profile/get'))
  const ownerId = plmId(profile?.id, 'PLM 负责人')
  const tag = `E2E-PLM-${tokenFactory()}`
  if (!/^E2E-PLM-[a-f0-9]{12}$/.test(tag)) throw new Error('BLOCKED: 非法 PLM 专属标记')
  const fixture = { tag, tenantId: resolvedTenant, ownerId,
    ownerName: profile.nickname || profile.username, retention: '保留专属验收业务数据；临时权限账号最终停用' }
  caseRecord.fixtures = { ...(caseRecord.fixtures || {}), plm: fixture }
  const pmsBody = {
    name: `${tag}-PMS`, type: 1, level: 3, description: tag,
    openStatus: false, icon: 'ep:folder', memberUserIds: [ownerId]
  }
  fixture.pmsProjectId = plmId(dataOf(await api.postBusiness('/pms/pm/project/create', pmsBody)), 'PMS 项目')
  fixture.pmsBody = pmsBody
  const pms = dataOf(await api.getBusiness(`/pms/pm/project/get?id=${fixture.pmsProjectId}`))
  requireFact(caseRecord, 'PLM 专属 PMS 项目正式创建并保留私有范围',
    String(pms?.id) === fixture.pmsProjectId && pms.name === pmsBody.name &&
    pms.description === tag && pms.openStatus === false && pms.ownerStatus === true, { id: pms?.id, name: pms?.name })
  const projectBody = {
    bizType: 'PROJECT', bizNo: `${tag}-RDM`, bizName: `${tag}-RDM`,
    status: 'DRAFT', stageCode: 'INIT', stageName: '立项',
    ownerId, ownerName: fixture.ownerName, remark: tag,
    dataJson: JSON.stringify({ fixtureTag: tag, pmsProjectId: fixture.pmsProjectId }),
    items: PLM_STAGES.map((stage, index) => ({
      itemType: 'STAGE', itemCode: stage, itemName: stage, itemValue: 'PENDING', sortOrder: index + 1
    }))
  }
  fixture.projectId = plmId(dataOf(await api.postBusiness('/plm/rdm/record/create', projectBody)), 'PLM 项目')
  fixture.projectBody = projectBody
  const project = dataOf(await api.getBusiness(`/plm/rdm/project/ledger/get?id=${fixture.projectId}`))
  const meta = JSON.parse(project?.dataJson || '{}')
  requireFact(caseRecord, 'PLM 项目正式回读专属标记与 PMS 引用元数据',
    String(project?.id) === fixture.projectId && project.bizNo === projectBody.bizNo &&
    project.remark === tag && meta.pmsProjectId === fixture.pmsProjectId &&
    meta.fixtureTag === tag, { projectId: fixture.projectId, pmsProjectId: meta.pmsProjectId })
  fixture.productNo = `${tag}-P`
  fixture.productId = plmId(dataOf(await api.postBusiness('/plm/core/product/create', {
    productNo: fixture.productNo, productName: `${tag}-product`, sourceProjectId: fixture.projectId,
    lifecycleStatus: 'DRAFT', ownerId, ownerName: fixture.ownerName, remark: tag
  })), '产品')
  const product = dataOf(await api.getBusiness(`/plm/core/product/get?id=${fixture.productId}`))
  requireFact(caseRecord, 'PLM 专属产品来源研发项目可追溯',
    String(product?.id) === fixture.productId && product.productNo === fixture.productNo &&
    product.remark === tag && String(product.sourceProjectId) === fixture.projectId,
    { productId: fixture.productId, sourceProjectId: product?.sourceProjectId })
  const unit = plmRows(await api.getBusiness('/mes/basUnit/list/enabled')).find((row) => row.id && row.name)
  if (!unit) throw new Error('BLOCKED: PLM 写侧缺少启用计量单位')
  fixture.unit = { id: plmId(unit.id, '计量单位'), name: unit.name }
  // MES prodBom dereferences the component category; use an existing read-only master.
  const category = plmRows(await api.getBusiness(
    '/mes/basMaterialCategory/rootList?pageNo=1&pageSize=100')).find((row) => row.id && row.name)
  if (!category) throw new Error('BLOCKED: PLM 下游用料展开缺少物料分类')
  fixture.categoryId = plmId(category.id, '物料分类')
  for (const suffix of ['parent', 'component']) {
    const code = `${tag}-${suffix === 'parent' ? 'P' : 'C'}`
    const materialBody = {
      code, name: `${tag}-${suffix}`, auxName: code, unitId: fixture.unit.id, categoryId: fixture.categoryId,
      inventoryNature: 'STOCK', isMaterial: 'Y', isEnabled: 1,
      purchased: 'Y', leadTime: 1, bufferTime: 0,
      source: suffix === 'parent' ? 'mixed' : 'purchase',
      saled: 'N', produced: suffix === 'parent' ? 'Y' : 'N', batchManaged: 'Y',
      oneBarcode: 'N', periodManaged: 'N', gradeManaged: 'N', remark: tag
    }
    const materialId = plmId(dataOf(await api.postBusiness('/mes/basMaterial/add', materialBody)), 'MES 物料')
    const material = dataOf(await api.getBusiness(`/mes/basMaterial/queryById?id=${materialId}`))
    requireFact(caseRecord, `PLM 专属 ${suffix} MES 物料写入回读`,
      String(material?.id) === materialId && material.code === code && material.remark === tag &&
      String(material.unitId) === fixture.unit.id && String(material.categoryId) === fixture.categoryId, { materialId, code })
    const partId = plmId(dataOf(await api.postBusiness('/plm/core/part/create', {
      partNo: code, partName: `${tag}-${suffix}`, partType: suffix === 'parent' ? 'PRODUCT' : 'MATERIAL',
      unit: unit.name, lifecycleStatus: 'DRAFT', ownerId, ownerName: fixture.ownerName,
      materialId, materialCode: code, materialName: material.name, remark: tag
    })), '零件')
    const part = dataOf(await api.getBusiness(`/plm/core/part/get?id=${partId}`))
    requireFact(caseRecord, `PLM 专属 ${suffix} 零件映射真实物料`,
      String(part?.id) === partId && part.partNo === code && part.remark === tag &&
      String(part.materialId) === materialId, { partId, materialId })
    const revisionId = plmId(dataOf(await api.postBusiness('/plm/core/part/revision/create', {
      partId, revisionNo: 'A', iterationNo: 1, description: tag
    })), '零件版本')
    const revisions = plmRows(await api.getBusiness(
      `/plm/core/part/revision/page?${query({ pageNo: 1, pageSize: 100, partId })}`))
    const revision = revisions.find((row) => String(row.id) === revisionId)
    requireFact(caseRecord, `PLM 专属 ${suffix} A 版本创建及归属回读`,
      revision?.revisionNo === 'A' && String(revision?.partId) === partId &&
      revision.revisionStatus === 'WIP' && revision.description === tag, { partId, revisionId })
    fixture[suffix] = { materialId, partId, revisionId, code }
    await expectPlmRejection({ api, method: 'POST', path: '/plm/core/part/revision/create',
      body: { partId, revisionNo: 'A', iterationNo: 1, description: tag }, caseRecord,
      expected: { code: 400, message: '同一零部件下版本号不能重复' },
      name: `PLM ${suffix} 同零件重复 A 版本被拒绝` })
    const afterDuplicate = plmRows(await api.getBusiness(
      `/plm/core/part/revision/page?${query({ pageNo: 1, pageSize: 100, partId })}`))
    requireFact(caseRecord, `PLM ${suffix} 重复版本请求不新增或覆盖历史`,
      isDeepStrictEqual(revisions, afterDuplicate), { partId, count: afterDuplicate.length })
  }
  await api.putBusiness('/plm/core/product/update', {
    productNo: fixture.productNo, productName: product.productName, id: fixture.productId,
    targetMaterialId: fixture.parent.materialId, sourceProjectId: fixture.projectId,
    lifecycleStatus: 'DRAFT', ownerId, ownerName: fixture.ownerName, remark: tag
  })
  const mapped = dataOf(await api.getBusiness(`/plm/core/product/get?id=${fixture.productId}`))
  requireFact(caseRecord, 'PLM 产品绑定专属 MES 母件并保留来源',
    String(mapped?.targetMaterialId) === fixture.parent.materialId &&
    String(mapped?.sourceProjectId) === fixture.projectId && mapped.remark === tag,
    { productId: fixture.productId, targetMaterialId: mapped?.targetMaterialId })
  fixture.lineBody = {
    ebomId: fixture.parent.revisionId, parentPartRevisionId: fixture.parent.revisionId,
    componentPartId: fixture.component.partId, componentRevisionId: fixture.component.revisionId,
    lineNo: 1, quantity: 1, unit: unit.name, bomStatus: 'WIP', approvalStatus: 'PENDING', remark: tag
  }
  fixture.lineId = plmId(dataOf(await api.postBusiness('/plm/core/ebom/save-line', fixture.lineBody)), 'EBOM 行')
  await readOwnedEbom(api, fixture, caseRecord, 'PLM 专属 EBOM 父子件版本及数量回读')
  fixture.processBody = {
    bizType: 'PROCESS', bizName: `${tag}-process`, projectId: fixture.projectId,
    versionNo: 'A', status: 'DRAFT', remark: tag, items: [{
      itemType: 'PROCESS_PARAM', itemCode: 'TEMP', itemName: 'Temperature',
      itemValue: 'Prepare', numericValue: 20, unitName: 'C',
      lowerLimit: 18, upperLimit: 22, sortOrder: 1
    }]
  }
  fixture.processId = plmId(dataOf(await api.postBusiness('/plm/rdm/record/create', fixture.processBody)), '工艺版本')
  const process = dataOf(await api.getBusiness(`/plm/rdm/record/get?id=${fixture.processId}&bizType=PROCESS`))
  requireFact(caseRecord, 'PLM 工艺版本来源项目及参数正式回读',
    String(process?.id) === fixture.processId && process.versionNo === 'A' && process.status === 'DRAFT' &&
    String(process.projectId) === fixture.projectId && process.remark === tag &&
    process.items?.length === 1 && process.items[0].itemCode === 'TEMP' &&
    Number(process.items[0].numericValue) === 20, { processId: fixture.processId, version: process?.versionNo })
  fixture.recipeBody = {
    bizType: 'RECIPE', bizName: `${tag}-recipe`, projectId: fixture.projectId,
    versionNo: 'A', status: 'DRAFT', ownerId, ownerName: fixture.ownerName, remark: tag,
    dataJson: JSON.stringify({ fixtureTag: tag }), items: [{
      itemType: 'INGREDIENT', itemCode: fixture.component.code, itemName: `${tag}-component`,
      numericValue: 1, unitName: fixture.unit.name, sortOrder: 1, extraJson: tag
    }]
  }
  fixture.recipeId = plmId(dataOf(await api.postBusiness('/plm/rdm/record/create', fixture.recipeBody)), '配方版本')
  await readOwnedRdmVersion(api, fixture, caseRecord, 'RECIPE', 'DRAFT',
    'PLM 配方版本来源项目及真实物料用量正式回读')
  caseRecord.evidence.push(`PLM 本轮专属数据 ${tag}，PMS=${fixture.pmsProjectId}，研发=${fixture.projectId}，产品=${fixture.productId}，EBOM=${fixture.parent.revisionId}，工艺=${fixture.processId}`)
  return fixture
}

async function readOwnedRdmVersion (api, fixture, caseRecord, bizType, status, name) {
  const isRecipe = bizType === 'RECIPE'
  const id = isRecipe ? fixture.recipeId : fixture.processId
  const body = isRecipe ? fixture.recipeBody : fixture.processBody
  const row = dataOf(await api.getBusiness(`/plm/rdm/record/get?${query({ id, bizType })}`))
  requireFact(caseRecord, name, String(row?.id) === id && row.bizType === bizType &&
    String(row.projectId) === fixture.projectId && row.bizName === body.bizName &&
    row.versionNo === body.versionNo && row.status === status && row.remark === fixture.tag &&
    row.items?.length === 1 && row.items[0].itemCode === body.items[0].itemCode &&
    Number(row.items[0].numericValue) === body.items[0].numericValue &&
    row.items[0].unitName === body.items[0].unitName,
  { id, bizType, projectId: row?.projectId, versionNo: row?.versionNo, status: row?.status })
  return row
}

async function readOwnedEbom (api, fixture, caseRecord, name) {
  const tree = plmRows(await api.getBusiness(`/plm/core/ebom/tree?ebomId=${fixture.parent.revisionId}`))
  const row = tree.find((item) => String(item.id) === fixture.lineId)
  requireFact(caseRecord, name, tree.length === 1 && row?.remark === fixture.tag &&
    String(row.parentPartRevisionId) === fixture.parent.revisionId &&
    String(row.componentPartId) === fixture.component.partId &&
    String(row.componentRevisionId) === fixture.component.revisionId &&
    row.partVersion === 'A' && Number(row.quantity) === 1,
  { lineId: fixture.lineId, parentRevisionId: fixture.parent.revisionId, rows: tree.length })
  return row
}

export async function runPlmStages ({ api, fixture, caseRecord }) {
  const first = dataOf(await api.getBusiness(`/plm/rdm/project/ledger/get?id=${fixture.projectId}`))
  const stages = (first?.items || []).filter((row) => row.itemType === 'STAGE')
  requireFact(caseRecord, 'PLM 项目九阶段建模完整且顺序回读',
    isDeepStrictEqual(stages.map((row) => row.itemCode), [...PLM_STAGES]),
    { stages: stages.map((row) => row.itemCode) })
  fixture.stageTransitions = []
  for (const stage of PLM_STAGES.slice(0, -1)) {
    const tasksPath = `/plm/rdm/project/ledger/tasks?${query({ projectId: fixture.projectId, stageCode: stage })}`
    const tasks = plmRows(await api.getBusiness(tasksPath))
    requireFact(caseRecord, `PLM ${stage} 阶段任务非空且归属专属项目`,
      tasks.length > 0 && tasks.every((row) => String(row.projectId) === fixture.projectId), { count: tasks.length })
    for (const task of tasks) {
      const taskId = plmId(task.id, '阶段任务')
      const changed = dataOf(await api.postBusiness('/plm/rdm/project/ledger/task/update', {
        taskId, status: 'DONE', progressRate: 100, remark: fixture.tag
      }))
      requireFact(caseRecord, `PLM ${stage} 任务 ${taskId} 完成回读`,
        String(changed?.id) === taskId && String(changed?.projectId) === fixture.projectId &&
        changed.status === 'DONE' && Number(changed.progressRate) === 100, { taskId, status: changed?.status })
    }
    const done = plmRows(await api.getBusiness(tasksPath))
    const after = dataOf(await api.getBusiness(`/plm/rdm/project/ledger/get?id=${fixture.projectId}`))
    const index = PLM_STAGES.indexOf(stage)
    const next = PLM_STAGES[index + 1]
    const normalized = after?.stageCode === 'MASS_LAUNCH' ? 'MASS' : after?.stageCode
    requireFact(caseRecord, `PLM ${stage} 完成后自动推进 ${next}`,
      done.length === tasks.length && done.every((row) => row.status === 'DONE') && normalized === next,
      { stage, next: after?.stageCode, status: after?.status, completed: done.length })
    fixture.stageTransitions.push({ stage, next: after.stageCode, status: after.status })
  }
  const last = dataOf(await api.getBusiness(`/plm/rdm/project/ledger/get?id=${fixture.projectId}`))
  fact(caseRecord, 'PLM 项目阶段推进至 FINISHED 与 ARCHIVED',
    fixture.stageTransitions.length === 8 && last?.stageCode === 'FINISHED' && last.status === 'ARCHIVED',
    { status: last?.status, stage: last?.stageCode })
}

export async function createPlmIdentity ({ api, fixture, caseRecord, record, label, runtime = config,
  apiFactory = createApiClient }) {
  const permissions = [
    'pms:pm:project:query', 'pms:pm:project-member:query',
    'pms:pm:work-item:query', 'pms:pm:work-item:create', 'plm:rdm:query'
  ]
  const menus = plmRows(await api.getBusiness('/system/menu/list'))
  const assignable = new Set(plmRows(await api.getBusiness('/system/menu/list-all-simple')).map((row) => String(row.id)))
  const byId = new Map(menus.map((row) => [String(row.id), row]))
  const menuIds = new Set()
  for (const permission of permissions) {
    let row = menus.find((menu) => menu.permission === permission)
    if (!row) throw new Error(`BLOCKED: PLM 双身份缺少 ${permission} 权限菜单`)
    while (row && !menuIds.has(String(row.id))) {
      const id = plmId(row.id, '权限菜单')
      if (!assignable.has(id)) throw new Error(`BLOCKED: 租户套餐不含 ${permission} 的菜单 ${id}`)
      menuIds.add(id)
      row = byId.get(String(row.parentId))
    }
  }
  const suffix = fixture.tag.slice(-12)
  const username = `e2eplm${label}${suffix}`
  const password = `Plm!${randomBytes(4).toString('hex')}Aa9`
  let roleId
  let userId
  const cleanup = async () => {
    const failures = []
    if (userId) {
      try { await api.putBusiness('/system/user/update-status', { id: userId, status: 1 }) } catch (error) { failures.push(error) }
    }
    if (roleId) {
      try { await api.deleteBusiness(`/system/role/delete?id=${roleId}`) } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, `PLM ${label} 身份清理失败：${failures.map((error) => error.message).join('；')}`)
    if (userId) {
      const account = caseRecord.accounts?.find((row) => row.userId === userId)
      if (account) account.cleanupStatus = 'DISABLED_ROLE_REMOVED'
      fact(caseRecord, `PLM ${label} 专属账号停用与角色删除请求成功`, true, { userId, roleId })
    }
  }
  try {
    roleId = plmId(dataOf(await api.postBusiness('/system/role/create', {
      name: `${username}`, code: `${username}`, sort: 999, status: 0, remark: fixture.tag
    })), 'PLM 专属角色')
    await api.postBusiness('/system/permission/assign-role-menu', { roleId, menuIds: [...menuIds] })
    userId = plmId(dataOf(await api.postBusiness('/system/user/create', {
      username, password, nickname: username, sex: 0, postIds: [], remark: fixture.tag
    })), 'PLM 专属用户')
    // Store audit coordinates immediately, even if assigning roles or logging in fails.
    caseRecord.accounts = [...(caseRecord.accounts || []), { userId, username, roleId, label, tenantId: fixture.tenantId }]
    await api.postBusiness('/system/permission/assign-user-role', { userId, roleIds: [roleId] })
    const anonymous = apiFactory({ tenantId: fixture.tenantId })
    let response = await anonymous.request('POST', '/system/auth/login-encrypted', {
      tenantName: runtime.tenantName, username, password, captchaVerification: '', rememberMe: false
    }, { encrypted: true })
    let session = dataOf(response)
    if (!session?.accessToken && !session?.token) {
      const choices = dataOf(await anonymous.request('POST', '/system/auth/tenant-options-encrypted', {
        tenantName: runtime.tenantName, username, password
      }, { encrypted: true }))
      if (!choices?.selectionTicket) throw new Error('BLOCKED: PLM 临时账号未取得租户选择票据')
      response = await anonymous.request('POST', '/system/auth/login-tenant-selection', {
        selectionTicket: choices.selectionTicket, tenantId: fixture.tenantId
      })
      session = dataOf(response)
    }
    const token = session?.accessToken || session?.token
    if (!token) throw new Error('BLOCKED: PLM 双身份登录未返回令牌')
    if (session.tenantId == null || String(session.tenantId) !== fixture.tenantId) {
      throw new Error('BLOCKED: PLM 临时身份登录返回的租户不匹配')
    }
    const identityApi = apiFactory({ token, tenantId: fixture.tenantId, record })
    const who = dataOf(await identityApi.getBusiness('/system/user/profile/get'))
    requireFact(caseRecord, `PLM ${label} 身份独立登录回读`,
      String(who?.id) === userId && who.username === username && userId !== fixture.ownerId,
      { userId, username })
    const granted = dataOf(await identityApi.getBusiness('/system/auth/get-permission-info'))
    requireFact(caseRecord, `PLM ${label} 全局权限独立回读`,
      Array.isArray(granted?.permissions) && permissions.every((permission) => granted.permissions.includes(permission)) &&
      !granted.permissions.includes('*:*:*'), { userId, requiredPermissions: permissions })
    return { userId, api: identityApi, cleanup }
  } catch (error) {
    try { await cleanup() } catch (cleanupError) {
      fact(caseRecord, `PLM ${label} 身份准备失败后清理`, false, cleanupError.message)
    }
    throw error
  }
}

export async function runPlmPermissions ({ api, fixture, caseRecord, ...dependencies }) {
  const identities = []
  const membersToRemove = new Set()
  try {
    const writer = await createPlmIdentity({ api, fixture, caseRecord, label: 'writer', ...dependencies })
    identities.push(writer)
    const reader = await createPlmIdentity({ api, fixture, caseRecord, label: 'reader', ...dependencies })
    identities.push(reader)
    await api.putBusiness('/pms/pm/project-member/update-list', {
      projectId: fixture.pmsProjectId,
      members: [{ userId: fixture.ownerId, level: 1 }, { userId: writer.userId, level: 3 }, { userId: reader.userId, level: 4 }]
    })
    membersToRemove.add(writer.userId)
    membersToRemove.add(reader.userId)
    const members = plmRows(await api.getBusiness(`/pms/pm/project-member/list?projectId=${fixture.pmsProjectId}`))
    requireFact(caseRecord, 'PLM PMS 编辑和只读成员真实权限级别回读',
      members.some((row) => String(row.userId) === writer.userId && row.level === 3) &&
      members.some((row) => String(row.userId) === reader.userId && row.level === 4), { count: members.length })
    const writerProject = dataOf(await writer.api.getBusiness(`/pms/pm/project/get?id=${fixture.pmsProjectId}`))
    const readerProject = dataOf(await reader.api.getBusiness(`/pms/pm/project/get?id=${fixture.pmsProjectId}`))
    fact(caseRecord, 'PLM PMS 双身份同项目读写范围不同',
      writerProject?.writeStatus === true && readerProject?.writeStatus === false &&
      writerProject.memberStatus === true && readerProject.memberStatus === true,
      { writer: writerProject?.writeStatus, reader: readerProject?.writeStatus })
    const workBody = { projectId: fixture.pmsProjectId, type: 3, name: `${fixture.tag}-task`,
      description: fixture.tag, priority: 2, assigneeUserId: writer.userId, progress: 0 }
    fixture.workItemId = plmId(dataOf(await writer.api.postBusiness('/pms/pm/work-item/create', workBody)), '编辑成员任务')
    const task = dataOf(await writer.api.getBusiness(`/pms/pm/work-item/get?id=${fixture.workItemId}`))
    fact(caseRecord, 'PLM PMS 编辑成员正式创建并回读任务',
      String(task?.id) === fixture.workItemId && String(task?.projectId) === fixture.pmsProjectId &&
      task?.name === workBody.name, { id: fixture.workItemId })
    await expectPlmRejection({ api: reader.api, method: 'POST', path: '/pms/pm/work-item/create',
      body: { ...workBody, name: `${fixture.tag}-reader-denied` }, caseRecord,
      expected: { code: 2050200003, message: '当前项目角色无编辑权限' },
      name: 'PLM PMS 只读成员具有全局创建权限但项目写入被拒绝' })
    await api.deleteBusiness(`/pms/pm/project-member/delete?${query({ projectId: fixture.pmsProjectId, userId: reader.userId })}`)
    membersToRemove.delete(reader.userId)
    await expectPlmRejection({ api: reader.api, method: 'GET',
      path: `/pms/pm/project/get?id=${fixture.pmsProjectId}`, caseRecord,
      expected: { code: 2050200000, message: '无权访问该项目' },
      name: 'PLM PMS 移除成员后私有项目不可读' })
    // Both identities have PLM query permission; only a project-scope denial qualifies.
    for (const [path, name] of [
      [`/plm/rdm/project/ledger/get?id=${fixture.projectId}`, 'PLM 非项目成员不能凭全局查询权限读取研发项目'],
      [`/plm/core/product/get?id=${fixture.productId}`, 'PLM 非项目成员不能凭全局查询权限读取项目产品']
    ]) {
      await expectPlmRejection({ api: reader.api, method: 'GET', path, caseRecord, name,
        expected: { code: 2050200000, message: '无权访问该项目' } })
    }
  } finally {
    for (const identity of identities.reverse()) {
      try {
        if (membersToRemove.has(identity.userId)) {
          await api.deleteBusiness(`/pms/pm/project-member/delete?${query({
            projectId: fixture.pmsProjectId, userId: identity.userId
          })}`)
        }
      } catch (error) {
        fact(caseRecord, 'PLM 专属成员清理', false, error.message)
      }
      try { await identity.cleanup() } catch (error) {
        fact(caseRecord, 'PLM 专属权限账号停用与角色清理', false, error.message)
      }
    }
  }
}

export async function runPlmKnowledgeReference ({ api, knowledgeApi = api, fixture, caseRecord }) {
  // The page VO may contain content. Use an unrecorded client and retain only IDs.
  const documents = plmRows(await knowledgeApi.getBusiness('/ai/knowledge/document/page?pageNo=1&pageSize=100&status=0'))
  const document = documents.find((row) => row.id && row.knowledgeId)
  if (!document) {
    caseRecord.notes.push('PLM 知识引用缺前置：当前知识中枢没有可引用文档；未复制或创建平行 KB 正文。')
    return
  }
  const reference = { knowledgeDocumentId: plmId(document.id, '知识文档'),
    knowledgeId: plmId(document.knowledgeId, '知识库') }
  const body = { ...fixture.projectBody, id: fixture.projectId,
    dataJson: JSON.stringify({ fixtureTag: fixture.tag, pmsProjectId: fixture.pmsProjectId,
      knowledgeReferences: [reference] }) }
  // Run before stage tasks are generated: generic project update replaces children.
  await api.putBusiness('/plm/rdm/record/update', body)
  const project = dataOf(await api.getBusiness(`/plm/rdm/project/ledger/get?id=${fixture.projectId}`))
  const metadata = JSON.parse(project?.dataJson || '{}')
  fact(caseRecord, 'PLM 知识引用扩展仅保存知识中枢标识并正式回读',
    isDeepStrictEqual(metadata.knowledgeReferences, [reference]) &&
    Object.keys(metadata).sort().join(',') === 'fixtureTag,knowledgeReferences,pmsProjectId',
    { projectId: fixture.projectId, ...reference })
  fixture.knowledgeReference = reference
  caseRecord.notes.push(PLM_CONTRACT_GAPS.knowledge)
}

export async function runPlmPlanReference ({ api, fixture, caseRecord, bomId, label,
  expectDenied = false, materials = [], srcBillType }) {
  const billNo = `${fixture.tag}-${label}`
  const body = {
    prodNo: billNo, billNo, prodType: '1', remark: fixture.tag,
    ...(srcBillType ? { srcBillType } : {}),
    expectStartDate: new Date(Date.now() + 3600000).toISOString().slice(0, 19).replace('T', ' '),
    expectEndDate: new Date(Date.now() + 7200000).toISOString().slice(0, 19).replace('T', ' '),
    prodOrderSubList: [{ materialId: fixture.parent.materialId, qty: 1,
      wmsAssembleId: bomId, remark: fixture.tag, urgentLevel: '1' }],
    prodOrderMaterialList: materials
  }
  const expected = { codes: [400, 500],
    message: /(?:BOM|版本|基线).*(?:未发布|未启用|尚未发布|尚未启用|发布后|启用后)/i,
    allowServiceCode: true }
  const response = await api.request('POST', '/mes/prodOrder/add', body,
    expectDenied ? { expectedBusinessRejection: expected } : {})
  if (expectDenied) {
    fact(caseRecord, `PLM ${label} 未发布模型不能被生产计划引用`,
      matchesExpectedBusinessRejection(response, expected),
      { code: response?.code, unexpectedlyAccepted: isBusinessSuccess(response), bomId })
  } else {
    fact(caseRecord, 'PLM 下发后生产计划正式 API 保存 BOM 引用',
      isBusinessSuccess(response), { code: response?.code, bomId })
  }
  if (!isBusinessSuccess(response)) {
    if (!expectDenied) dataOf(response)
    return null
  }
  const id = plmId(dataOf(response), '生产计划消费样本')
  fixture.planReferences ||= []
  fixture.planReferences.push({ id, label, bomId, expectedDenied: expectDenied })
  const main = dataOf(await api.getBusiness(`/mes/prodOrder/queryById?id=${id}`))
  const lines = plmRows(await api.getBusiness(`/mes/prodOrder/queryMesProdOrderSubByMainId?id=${id}`))
  requireFact(caseRecord, `PLM ${label} 生产计划专属来源和 BOM 引用回读`,
    String(main?.id) === id && main.remark === fixture.tag && main.billNo === billNo &&
    lines.length === 1 && String(lines[0].mid) === id &&
    String(lines[0].materialId) === fixture.parent.materialId &&
    String(lines[0].wmsAssembleId) === bomId && Number(lines[0].qty) === 1 &&
    (!srcBillType || main.srcBillType === srcBillType),
    { planId: id, bomId, billNo })
  caseRecord.evidence.push(`生产计划专属引用样本=${id}，BOM=${bomId}；保存计划本身不等于发布基线/工艺正式消费。`)
  return { id, lines }
}

async function readRdmMesRelease (api, fixture, caseRecord, release, label) {
  const bomId = plmId(release?.mesBomId, 'RDM 下发 MES BOM')
  const routeId = plmId(release?.mesRouteId, 'RDM 下发 MES 工艺路线')
  requireFact(caseRecord, `PLM ${label} RDM 下发响应保留指定项目配方工艺版本`,
    String(release.projectId) === fixture.projectId && release.launchStage === 'PILOT' &&
    release.produceOrigin === '2' && String(release.targetMaterialId) === fixture.parent.materialId &&
    String(release.recipeVersionId) === fixture.recipeId && release.recipeVersionNo === 'A' &&
    String(release.processVersionId) === fixture.processId && release.processVersionNo === 'A' &&
    release.mesBomVersion === 'A' && release.mesRouteVersion === 'A' &&
    Number(release.procedureCount) === 1 && Number(release.bomItemCount) === 1 &&
    release.bomValidated === true && Number(release.bomMissingCount) === 0,
  { projectId: release.projectId, bomId, routeId, recipeVersionId: release.recipeVersionId,
    processVersionId: release.processVersionId })
  const bom = dataOf(await api.getBusiness(`/mes/wmsAssemble/queryById?id=${bomId}`))
  const route = dataOf(await api.getBusiness(`/mes/wmsTechRoute/queryById?id=${routeId}`))
  requireFact(caseRecord, `PLM ${label} RDM MES 主档是专属启用 BOM 和工艺路线`,
    String(bom?.id) === bomId && String(bom.projectId) === fixture.projectId &&
    String(bom.stockId) === fixture.parent.materialId && String(bom.defaultTechnique) === routeId &&
    bom.bomUsage === 'PRODUCTION' && bom.version === 'A' && Number(bom.devStatus) === 2 &&
    Number(bom.stockCount) === 1 &&
    String(bom.mark).includes(`[${fixture.projectBody.bizNo}]`) && String(bom.mark).includes('配方版本[A]') &&
    String(route?.id) === routeId && String(route.projectId) === fixture.projectId &&
    route.name === fixture.processBody.bizName && route.version === 'A' && Number(route.devStatus) === 2 &&
    String(route.mark).includes(`[${fixture.projectBody.bizNo}]`) && String(route.mark).includes('工艺版本[A]'),
  { bomId, routeId, bomStatus: bom?.devStatus, routeStatus: route?.devStatus })
  const bomLines = plmRows(await api.getBusiness(
    `/mes/wmsAssemble/queryWmsAssembleSubByMainId?${query({ id: bomId, pageNo: 1, pageSize: 100 })}`))
  const routeLines = plmRows(await api.getBusiness(
    `/mes/wmsTechRoute/listMesWmsTechRouteSubByMainId?${query({ parentId: routeId, pageNo: 1, pageSize: 100 })}`))
  const bomLine = bomLines[0]
  const routeLine = routeLines[0]
  requireFact(caseRecord, `PLM ${label} RDM BOM 子件真实用量绑定下发工艺工序`,
    bomLines.length === 1 && routeLines.length === 1 &&
    String(bomLine.parentId) === bomId && String(routeLine.parentId) === routeId &&
    String(bomLine.stockId) === fixture.component.materialId && Number(bomLine.subStockCount) === 1 &&
    bomLine.mark === fixture.tag && String(routeLine.relationId) === fixture.parent.materialId &&
    Number(routeLine.sortOrder) === 1 &&
    plmId(bomLine.procedureId, 'BOM 工序') === plmId(routeLine.procedureId, '路线工序') &&
    nonblank(routeLine.procedureName),
  { bomId, routeId, bomLines: bomLines.length, routeLines: routeLines.length })
  const project = dataOf(await api.getBusiness(`/plm/rdm/project/ledger/get?id=${fixture.projectId}`))
  const metadata = JSON.parse(project?.dataJson || '{}')
  const info = metadata.mesRelease
  const material = dataOf(await api.getBusiness(`/mes/basMaterial/queryById?id=${fixture.parent.materialId}`))
  requireFact(caseRecord, `PLM ${label} RDM 项目发布审计与物料默认 BOM 路线正式回读`,
    String(project?.id) === fixture.projectId && project.remark === fixture.tag &&
    metadata.fixtureTag === fixture.tag && metadata.pmsProjectId === fixture.pmsProjectId &&
    info?.launchStage === 'PILOT' && info.produceOrigin === '2' &&
    String(info.targetMaterialId) === fixture.parent.materialId &&
    String(info.recipeVersionId) === fixture.recipeId && info.recipeVersionNo === 'A' &&
    String(info.processVersionId) === fixture.processId && info.processVersionNo === 'A' &&
    String(info.mesBomId) === bomId && info.mesBomVersion === 'A' &&
    String(info.mesRouteId) === routeId && info.mesRouteVersion === 'A' &&
    Boolean(info.releasedAt) && nonblank(info.releasedBy) && info.remark === fixture.tag &&
    String(material?.id) === fixture.parent.materialId && material.remark === fixture.tag &&
    String(material.defaultProdBom) === bomId && String(material.defaultTechnique) === routeId,
  { bomId, routeId, releasedAt: info?.releasedAt, releasedBy: info?.releasedBy })
  return {
    bom: { id: bomId, version: bom.version, mark: bom.mark, defaultTechnique: bom.defaultTechnique },
    route: { id: routeId, version: route.version, mark: route.mark },
    bomLines: bomLines.map((row) => ({ id: plmId(row.id, 'BOM 子行'), parentId: row.parentId,
      stockId: row.stockId, subStockCount: row.subStockCount, procedureId: row.procedureId, mark: row.mark })),
    routeLines: routeLines.map((row) => ({ id: plmId(row.id, '路线子行'), parentId: row.parentId,
      procedureId: row.procedureId, relationId: row.relationId, sortOrder: row.sortOrder })),
    release: info
  }
}

export async function runPlmMesRelease ({ api, fixture, caseRecord }) {
  await readOwnedRdmVersion(api, fixture, caseRecord, 'RECIPE', 'DRAFT', 'PLM RDM 下发前配方草稿归属确认')
  await readOwnedRdmVersion(api, fixture, caseRecord, 'PROCESS', 'DRAFT', 'PLM RDM 下发前工艺草稿归属确认')
  const body = { projectId: fixture.projectId, launchStage: 'PILOT',
    targetMaterialId: fixture.parent.materialId, recipeVersionId: fixture.recipeId,
    processVersionId: fixture.processId, remark: fixture.tag }
  const draft = await expectPlmRejection({ api, method: 'POST', path: '/plm/rdm/project/ledger/release-to-mes',
    body, caseRecord, name: 'PLM RDM 草稿配方工艺不能下发启用 MES 模型',
    expected: { code: 400, message: /(?:配方|工艺|版本).*(?:未发布|尚未发布|未审批|审批通过|发布后)/ } })
  if (isBusinessSuccess(draft.response)) {
    fixture.prematureRdmRelease = await readRdmMesRelease(api, fixture, caseRecord, dataOf(draft.response), 'DRAFT')
    caseRecord.notes.push('产品缺陷：RDM 草稿配方/工艺被下发为启用 MES 模型；拒绝检查失败，不能声称发布前门禁通过。')
  }
  // This prepares explicit API-supported status fixtures, not simulated BPM approval.
  for (const [bizType, id, versionBody] of [
    ['RECIPE', fixture.recipeId, fixture.recipeBody], ['PROCESS', fixture.processId, fixture.processBody]
  ]) {
    await api.putBusiness('/plm/rdm/record/update', { ...versionBody, id, status: 'RELEASED' })
    await readOwnedRdmVersion(api, fixture, caseRecord, bizType, 'RELEASED',
      `PLM RDM ${bizType} 发布状态夹具正式回读不冒充审批`)
  }
  caseRecord.notes.push(PLM_CONTRACT_GAPS.approval)
  const response = dataOf(await api.postBusiness('/plm/rdm/project/ledger/release-to-mes', body))
  const first = await readRdmMesRelease(api, fixture, caseRecord, response, 'RELEASED')
  fixture.rdmRelease = { ...body, mesBomId: first.bom.id, mesRouteId: first.route.id }
  const repeated = dataOf(await api.postBusiness('/plm/rdm/project/ledger/release-to-mes', body))
  const second = await readRdmMesRelease(api, fixture, caseRecord, repeated, 'REPEAT')
  fact(caseRecord, 'PLM RDM 重复下发保持主子实体和首次发布审计幂等',
    isDeepStrictEqual(first, second), {
      firstBomId: first.bom.id, repeatedBomId: second.bom.id,
      firstRouteId: first.route.id, repeatedRouteId: second.route.id,
      firstBomLineIds: first.bomLines.map((row) => row.id),
      repeatedBomLineIds: second.bomLines.map((row) => row.id),
      firstRouteNodeIds: first.routeLines.map((row) => row.id),
      repeatedRouteNodeIds: second.routeLines.map((row) => row.id),
      firstReleasedAt: first.release.releasedAt, repeatedReleasedAt: second.release.releasedAt
    })
  await runPlmMesConsumption({ api, fixture, caseRecord })
}

export async function runPlmMesConsumption ({ api, fixture, caseRecord }) {
  const { mesBomId: bomId, mesRouteId: routeId } = fixture.rdmRelease
  const expanded = plmRows(await api.postBusiness('/mes/prodOrder/prodBom', [{
    materialId: fixture.parent.materialId, versionId: bomId, num: 1
  }]))
  const component = expanded[0]
  requireFact(caseRecord, 'PLM MES 正式用料展开消费下发 BOM 工艺和真实数量',
    expanded.length === 1 && String(component.id) === fixture.component.materialId &&
    String(component.pid) === fixture.parent.materialId && String(component.defaultRoute) === routeId &&
    String(component.unitId) === fixture.unit.id &&
    Number(component.bomNum) === 1 && Number(component.qty) === 1 && Number(component.quantity) === 1,
  { bomId, routeId, rows: expanded.length, materialId: component?.id, quantity: component?.quantity })
  const plan = await runPlmPlanReference({ api, fixture, caseRecord, bomId, label: 'RDM', srcBillType: '2',
    materials: [{ materialId: component.id, unitId: component.unitId, bomNum: component.bomNum,
      quantity: component.quantity, claimed: 0, requested: 0, afterSaveClaimed: 0,
      afterSaveRequested: 0, remark: fixture.tag }] })
  fixture.mesConsumption = { planId: plan.id, status: 'PLAN_ONLY' }
  const materials = plmRows(await api.getBusiness(`/mes/prodOrderMaterial/queryByMainId?mid=${plan.id}`))
  requireFact(caseRecord, 'PLM MES 生产计划保存 API 展开用料且未虚填已领数量',
    materials.length === 1 && String(materials[0].mid) === plan.id &&
    String(materials[0].materialId) === fixture.component.materialId &&
    Number(materials[0].bomNum) === 1 && Number(materials[0].bomTotal) === 1 &&
    Number(materials[0].claimed) === 0 && materials[0].remark === fixture.tag, { planId: plan.id })
  const gate = dataOf(await api.getBusiness(`/mes/prodOrder/release-gate?prodOrderId=${plan.id}`))
  requireFact(caseRecord, 'PLM MES 下达门禁识别正式下发 BOM 已启用',
    String(gate?.prodOrderId) === plan.id && gate.enabled === true &&
    Array.isArray(gate.items) && gate.items.some((item) => item.code === 'BOM' && item.passed === true) &&
    gate.items.some((item) => item.code === 'MATERIAL' && typeof item.passed === 'boolean') &&
    typeof gate.passed === 'boolean' && gate.passed === gate.items.every((item) => item.passed === true),
  { planId: plan.id, gate })
  if (gate.passed !== true) {
    requireFact(caseRecord, 'PLM MES 缺料门禁返回真实专属子件缺口',
      gate.passed === false && gate.items.some((item) => item.code === 'MATERIAL' &&
        item.passed === false && item.details?.shortageMaterials?.some((row) =>
          String(row.materialId) === fixture.component.materialId && Number(row.shortageQty) > 0)),
    { planId: plan.id, gate })
    fixture.mesConsumption.status = 'BLOCKED'
    fixture.mesConsumption.gate = gate
    caseRecord.notes.push('PLM MES 工单消费尚缺真实齐套库存，未伪填 claimed/禁用门禁；计划与用料展开证据不能替代工单消费。')
    return
  }
  await api.putBusiness('/mes/prodOrder/check', { id: plan.id, approvalResultType: '1', approvalRemark: fixture.tag })
  const approved = dataOf(await api.getBusiness(`/mes/prodOrder/queryById?id=${plan.id}`))
  requireFact(caseRecord, 'PLM MES 专属计划正式审核后仍保留来源',
    String(approved?.id) === plan.id && approved.remark === fixture.tag && approved.srcBillType === '2' &&
    String(approved.billStage ?? approved.docStage) === '24', { planId: plan.id })
  await api.postBusiness('/mes/prodWork/transferWorkOrder', [{
    prodOrderId: plan.id, prodOrderSubId: plmId(plan.lines[0].id, '生产计划子行'),
    qty: 1, prodType: '1', operateType: 1, batchNo: `${fixture.tag}-RDM`
  }])
  const works = plmRows(await api.getBusiness(`/mes/prodWork/getWorkByProdOrderId?prodOrderId=${plan.id}`))
  requireFact(caseRecord, 'PLM MES 正式转工单消费专属计划 BOM 且数量守恒',
    works.length === 1 && String(works[0].prodOrderId) === plan.id &&
    String(works[0].prodOrderSubId) === String(plan.lines[0].id) &&
    String(works[0].assembleBomId) === bomId && String(works[0].materialId) === fixture.parent.materialId &&
    Number(works[0].qty) === 1 && Number(works[0].bomTotal) === 1 &&
    works[0].batchNo === `${fixture.tag}-RDM`, { planId: plan.id, works })
  const workId = plmId(works[0].id, 'MES 消费工单')
  const usage = plmRows(await api.postBusiness('/mes/prodOrder/prodBom', [{
    materialId: fixture.parent.materialId, versionId: bomId, num: 1, prodWorkId: workId
  }]))
  requireFact(caseRecord, 'PLM MES 工单实际物料清单保留源配方用量',
    usage.length === 1 && String(usage[0].id) === fixture.component.materialId &&
    String(usage[0].pid) === fixture.parent.materialId && Number(usage[0].bomNum) === 1 &&
    Number(usage[0].qty) === 1 && Number(usage[0].quantity) === 1 &&
    Boolean(plmId(usage[0].srcEntryId, '工单实际用料子行')), { planId: plan.id, workId })
  const relations = dataOf(await api.getBusiness(`/plm/rdm/project/ledger/relations?projectId=${fixture.projectId}`))
  fact(caseRecord, 'PLM MES 正式工单和试量产计划经项目关系 API 回流',
    String(relations?.projectId) === fixture.projectId && relations.pilotOrders?.length > 0 &&
    Number(relations.pilotProdOrderTotal) === relations.pilotOrders.length &&
    relations.pilotOrders.some((row) => String(row.id) === plan.id && row.billNo === `${fixture.tag}-RDM` &&
      row.produceOrigin === '研发试量产' && Number(row.qty) === 1) &&
    Number(relations.pilotWorkTotal) >= 1 && relations.workOrders?.some((row) =>
      String(row.id) === workId && String(row.prodOrderId) === plan.id &&
      row.produceOrigin === '研发试量产' && Number(row.qty) === 1),
  { projectId: fixture.projectId, planId: plan.id, workId })
  fixture.mesConsumption = { planId: plan.id, workId, status: 'WORK_CREATED' }
  caseRecord.evidence.push(`RDM 正式 MES 下发 BOM=${bomId}，路线=${routeId}，计划=${plan.id}，消费工单=${workId}；未冒充 ERP/core 基线消费或生产完工。`)
}

export async function runPlmRelease ({ api, fixture, caseRecord }) {
  const releaseBody = { ebomId: fixture.parent.revisionId, parentPartRevisionId: fixture.parent.revisionId,
    dryRun: false, operatorName: fixture.tag }
  const notApproved = dataOf(await api.postBusiness('/plm/core/ebom/preview-production-bom', { ...releaseBody, dryRun: true }))
  fact(caseRecord, 'PLM 未审批 EBOM 预览明确阻断而非空集',
    notApproved?.canRelease === false && notApproved?.released === false &&
    notApproved?.blocks?.some((block) => String(block.objectId) === fixture.lineId && /未审批/.test(block.reason)),
    { canRelease: notApproved?.canRelease, blockCount: notApproved?.blockCount })
  await expectPlmRejection({ api, method: 'POST', path: '/plm/core/ebom/release-production-bom',
    body: releaseBody, caseRecord, name: 'PLM 未审批 EBOM 正式下发拒绝',
    expected: { code: 400, message: 'EBOM 存在阻塞项，不能下发生产 BOM' } })
  const approvedBody = { ...fixture.lineBody, id: fixture.lineId, approvalStatus: 'APPROVED',
    effectiveDate: new Date(Date.now() - 86400000).toISOString().slice(0, 10), approvedBy: fixture.ownerName }
  await api.postBusiness('/plm/core/ebom/save-line', approvedBody)
  const premature = await expectPlmRejection({ api, method: 'POST',
    path: '/plm/core/ebom/release-production-bom', body: releaseBody, caseRecord,
    name: 'PLM 父子零件版本尚未发布时正式下发拒绝',
    expected: { code: 400, message: /(?:版本|发布|阻塞)/ } })
  if (isBusinessSuccess(premature.response) && premature.response.data?.targetMesBomId) {
    fixture.prematureMesBomId = plmId(premature.response.data.targetMesBomId, '未发布版本错误下发的 BOM')
    caseRecord.notes.push(`产品缺陷：WIP 父子版本被下发为 MES BOM=${fixture.prematureMesBomId}；样本保留，不当作发布前门禁通过。`)
    const prematureBom = await readMesBom(api, fixture, fixture.prematureMesBomId)
    requireFact(caseRecord, 'PLM WIP 反例 BOM 是专属草稿并保留版本来源',
      prematureBom.header.version === 'A' && Number(prematureBom.header.devStatus) === 0 &&
      String(prematureBom.header.mark).includes(`ebomId=${fixture.parent.revisionId}`) &&
      prematureBom.lines.length === 1 && Number(prematureBom.lines[0].subStockCount) === 1,
      { mesBomId: fixture.prematureMesBomId })
    await runPlmPlanReference({ api, fixture, caseRecord, bomId: fixture.prematureMesBomId,
      label: 'WIP', expectDenied: true })
  } else {
    caseRecord.notes.push('未发布版本下发被拒绝或没有返回精确 MES BOM ID，未构造虚假 BOM ID 测生产计划。')
  }
  for (const part of [fixture.parent, fixture.component]) {
    await api.putBusiness('/plm/core/part/revision/status', {
      id: part.revisionId, revisionStatus: 'RELEASED', description: fixture.tag
    })
    const versions = plmRows(await api.getBusiness(
      `/plm/core/part/revision/page?${query({ pageNo: 1, pageSize: 100, partId: part.partId })}`))
    const revision = versions.find((row) => String(row.id) === part.revisionId)
    requireFact(caseRecord, `PLM 版本 ${part.revisionId} 发布状态回读`,
      revision?.revisionStatus === 'RELEASED' && revision.releaseTime && revision.revisionNo === 'A',
      { revisionId: part.revisionId, status: revision?.revisionStatus })
  }
  await api.putBusiness('/plm/core/product/status', { id: fixture.productId, lifecycleStatus: 'RELEASED', remark: fixture.tag })
  const product = dataOf(await api.getBusiness(`/plm/core/product/get?id=${fixture.productId}`))
  requireFact(caseRecord, 'PLM 产品发布后状态映射和来源正式回读',
    String(product?.id) === fixture.productId && product.productNo === fixture.productNo &&
    product.lifecycleStatus === 'RELEASED' && product.remark === fixture.tag &&
    String(product.sourceProjectId) === fixture.projectId &&
    String(product.targetMaterialId) === fixture.parent.materialId,
    { productId: fixture.productId, lifecycleStatus: product?.lifecycleStatus })
  const baselines = plmRows(await api.getBusiness(
    `/plm/core/baseline/page?${query({ pageNo: 1, pageSize: 100, productId: fixture.productId })}`))
  const baseline = baselines.find((row) => String(row.productId) === fixture.productId && row.remark === fixture.tag)
  if (baseline) {
    fixture.baselineId = plmId(baseline.id, '专属基线')
    releaseBody.baselineId = fixture.baselineId
    const detail = dataOf(await api.getBusiness(`/plm/core/baseline/get?id=${fixture.baselineId}`))
    requireFact(caseRecord, 'PLM 专属基线详情归属回读',
      String(detail?.id) === fixture.baselineId && String(detail.productId) === fixture.productId &&
      detail.remark === fixture.tag, { baselineId: fixture.baselineId })
    const frozen = dataOf(await api.postBusiness('/plm/core/baseline/freeze', { id: fixture.baselineId, remark: fixture.tag }))
    requireFact(caseRecord, 'PLM 专属基线冻结状态及来源回读',
      String(frozen?.id) === fixture.baselineId && frozen.status === 'FROZEN' &&
      String(frozen.productId) === fixture.productId && Boolean(frozen.freezeTime),
      { baselineId: fixture.baselineId })
    const released = dataOf(await api.postBusiness('/plm/core/baseline/release', { id: fixture.baselineId, remark: fixture.tag }))
    fact(caseRecord, 'PLM 专属基线发布保留版本与来源',
      String(released?.productId) === fixture.productId && released.status === 'RELEASED' &&
      typeof released.versionNo === 'string' && released.versionNo.trim() !== '' && Boolean(released.releaseTime),
      { baselineId: fixture.baselineId, versionNo: released?.versionNo })
    const again = dataOf(await api.postBusiness('/plm/core/baseline/release', { id: fixture.baselineId, remark: fixture.tag }))
    fact(caseRecord, 'PLM 重复基线发布保留版本与首次发布时间',
      String(again?.id) === fixture.baselineId && String(again?.productId) === fixture.productId &&
      again.status === 'RELEASED' && nonblank(released.versionNo) &&
      Boolean(released.releaseTime) && again?.versionNo === released.versionNo &&
      isDeepStrictEqual(again?.releaseTime, released.releaseTime),
      { baselineId: fixture.baselineId })
  } else {
    caseRecord.notes.push(PLM_CONTRACT_GAPS.baseline)
  }
  const published = dataOf(await api.postBusiness('/plm/core/ebom/release-production-bom', releaseBody))
  fixture.mesBomId = plmId(published?.targetMesBomId, '正式下发 MES BOM')
  requireFact(caseRecord, 'PLM EBOM 正式下发回读真实 MES BOM 草稿',
    published.released === true && published.dryRun === false && published.releasedLineCount === 1 &&
    String(published.parentPartRevisionId) === fixture.parent.revisionId, { mesBomId: fixture.mesBomId })
  const snapshot = await readMesBom(api, fixture, fixture.mesBomId)
  fact(caseRecord, 'PLM MES API 回读版本来源数量且未冒充正式消费',
    snapshot.header.version === 'A' && String(snapshot.header.stockId) === fixture.parent.materialId &&
    String(snapshot.header.mark || '').includes(`ebomId=${fixture.parent.revisionId}`) &&
    snapshot.lines.length === 1 && String(snapshot.lines[0].stockId) === fixture.component.materialId &&
    Number(snapshot.lines[0].subStockCount) === 1 && Number(snapshot.header.devStatus) === 0,
    { mesBomId: fixture.mesBomId, version: snapshot.header.version, devStatus: snapshot.header.devStatus })
  // Core EBOM downlink creates a MES draft, not an enabled production model.
  await runPlmPlanReference({ api, fixture, caseRecord, bomId: fixture.mesBomId,
    label: 'CORE-DRAFT', expectDenied: true })
  const repeated = dataOf(await api.postBusiness('/plm/core/ebom/release-production-bom', releaseBody))
  const repeatedSnapshot = await readMesBom(api, fixture, fixture.mesBomId)
  fact(caseRecord, 'PLM 重复 EBOM 下发保持同 BOM 同子行与来源数量',
    repeated.released === true && repeated.dryRun === false &&
    String(repeated.targetMesBomId) === fixture.mesBomId && isDeepStrictEqual(snapshot, repeatedSnapshot),
    { first: fixture.mesBomId, repeated: repeated.targetMesBomId, lines: repeatedSnapshot.lines.length })
  const bRevisionId = plmId(dataOf(await api.postBusiness('/plm/core/part/revision/create', {
    partId: fixture.parent.partId, revisionNo: 'B', iterationNo: 1, description: fixture.tag
  })), '父件新版本 B')
  fixture.bRevisionId = bRevisionId
  fixture.bLineId = plmId(dataOf(await api.postBusiness('/plm/core/ebom/save-line', {
    ...approvedBody, id: undefined, ebomId: bRevisionId, parentPartRevisionId: bRevisionId, quantity: 2
  })), 'B 版 EBOM')
  await api.putBusiness('/plm/core/part/revision/status', { id: bRevisionId, revisionStatus: 'RELEASED', description: fixture.tag })
  const parentVersions = plmRows(await api.getBusiness(
    `/plm/core/part/revision/page?${query({ pageNo: 1, pageSize: 100, partId: fixture.parent.partId })}`))
  fact(caseRecord, 'PLM B 版发布后 A 版零件版本及状态保留',
    parentVersions.some((row) => String(row.id) === fixture.parent.revisionId && row.revisionNo === 'A' &&
      row.revisionStatus === 'RELEASED') &&
    parentVersions.some((row) => String(row.id) === bRevisionId && row.revisionNo === 'B' &&
      row.revisionStatus === 'RELEASED'), { partId: fixture.parent.partId })
  const bPublished = dataOf(await api.postBusiness('/plm/core/ebom/release-production-bom', { ...releaseBody,
    baselineId: undefined, ebomId: bRevisionId, parentPartRevisionId: bRevisionId }))
  fixture.bMesBomId = plmId(bPublished?.targetMesBomId, 'B 版下发 MES BOM')
  const bSnapshot = await readMesBom(api, fixture, fixture.bMesBomId)
  fact(caseRecord, 'PLM B 版正式下发有新版本用量与来源',
    bPublished.released === true && bPublished.dryRun === false &&
    bSnapshot.header.version === 'B' && bSnapshot.lines.length === 1 &&
    Number(bSnapshot.lines[0].subStockCount) === 2 &&
    String(bSnapshot.header.mark).includes(`ebomId=${bRevisionId}`),
    { mesBomId: fixture.bMesBomId, version: bSnapshot.header.version })
  const oldAfterNew = await readMesBom(api, fixture, fixture.mesBomId)
  fact(caseRecord, 'PLM B 版正式下发不覆盖 A 版 MES 历史',
    isDeepStrictEqual(snapshot, oldAfterNew), { oldVersion: snapshot.header.version,
      afterVersion: oldAfterNew.header.version, oldQuantity: snapshot.lines[0]?.subStockCount,
      afterQuantity: oldAfterNew.lines[0]?.subStockCount })
  await readOwnedEbom(api, fixture, caseRecord, 'PLM 发布 B 版后 A 版源 EBOM 仍可追溯')
  fixture.coreDownstreamReferences = plmRows(await api.getBusiness(
    `/plm/core/ebom/downstream-refs?ebomId=${fixture.parent.revisionId}`))
  fact(caseRecord, 'PLM 源 EBOM 下游引用接口有效数组回读但不冒充删除保护',
    true, { ebomId: fixture.parent.revisionId, references: fixture.coreDownstreamReferences })
  if (!fixture.coreDownstreamReferences.length) {
    caseRecord.notes.push('PLM core downstream-refs 真实回读为空，不能据此声称已消费 EBOM 的删除保护通过。')
  }
  const immutable = await expectPlmRejection({ api, method: 'POST', path: '/plm/core/ebom/save-line',
    body: approvedBody, caseRecord, name: 'PLM 已下发 A 版 EBOM 禁止原位保存',
    expected: { code: 400, message: /(?:发布|引用|消费|版本|修改|保护)/ } })
  await readOwnedEbom(api, fixture, caseRecord, 'PLM 已下发 A 版拒绝原位保存后完整源行不变')
  caseRecord.notes.push(PLM_CONTRACT_GAPS.consumption, PLM_CONTRACT_GAPS.history)
}

async function readMesBom (api, fixture, id) {
  const header = dataOf(await api.getBusiness(`/mes/wmsAssemble/queryById?id=${id}`))
  if (String(header?.id) !== id || String(header.stockId) !== fixture.parent.materialId ||
      !String(header.mark || '').includes('PLM_EBOM_RELEASE') || !String(header.mark).includes(fixture.tag)) {
    throw new Error('BLOCKED: 下游 MES BOM 非本轮专属物料或缺 PLM 来源')
  }
  const lines = plmRows(await api.getBusiness(
    `/mes/wmsAssemble/queryWmsAssembleSubByMainId?${query({ id, pageNo: 1, pageSize: 100 })}`))
  if (lines.some((row) => String(row.parentId) !== id ||
      String(row.stockId) !== fixture.component.materialId || !row.id ||
      !String(row.mark).includes(fixture.tag))) {
    throw new Error('BLOCKED: 下游 MES BOM 子行不属于本轮专属物料或主档')
  }
  return { header: { id: header.id, stockId: header.stockId, version: header.version,
    mark: header.mark, devStatus: header.devStatus },
  lines: lines.map((row) => ({ id: row.id, parentId: row.parentId, stockId: row.stockId,
    subStockCount: row.subStockCount, mark: row.mark })).sort((a, b) => String(a.id).localeCompare(String(b.id))) }
}

const nonblank = (value) => typeof value === 'string' && value.trim() !== ''

export async function runPlmWriteClosure ({ caseId, api, caseRecord, knowledgeApi, ...dependencies }) {
  initializePlmAssertions(caseRecord, caseId)
  if (caseId === 'PLM-001') {
    markPlmAssertion(caseRecord, 0, ['PLM 项目九阶段建模完整且顺序回读', 'PLM 项目阶段推进至 FINISHED 与 ARCHIVED'],
      PLM_CONTRACT_GAPS.association)
    markPlmAssertion(caseRecord, 1, ['PLM 专属产品来源研发项目可追溯',
      'PLM 专属 EBOM 父子件版本及数量回读', 'PLM 工艺版本来源项目及参数正式回读',
      'PLM 配方版本来源项目及真实物料用量正式回读',
      'PLM parent 同零件重复 A 版本被拒绝', 'PLM parent 重复版本请求不新增或覆盖历史',
      'PLM component 同零件重复 A 版本被拒绝', 'PLM component 重复版本请求不新增或覆盖历史'], PLM_CONTRACT_GAPS.version)
    markPlmAssertion(caseRecord, 2, ['PLM PMS 双身份同项目读写范围不同',
      'PLM writer 全局权限独立回读', 'PLM reader 全局权限独立回读',
      'PLM writer 专属账号停用与角色删除请求成功', 'PLM reader 专属账号停用与角色删除请求成功',
      'PLM PMS 编辑成员正式创建并回读任务',
      'PLM PMS 只读成员具有全局创建权限但项目写入被拒绝',
      'PLM PMS 移除成员后私有项目不可读',
      'PLM 非项目成员不能凭全局查询权限读取研发项目',
      'PLM 非项目成员不能凭全局查询权限读取项目产品'])
    markPlmAssertion(caseRecord, 3, ['PLM 知识引用扩展仅保存知识中枢标识并正式回读'], PLM_CONTRACT_GAPS.knowledge)
  } else {
    markPlmAssertion(caseRecord, 0, ['PLM 未审批 EBOM 正式下发拒绝',
      'PLM 父子零件版本尚未发布时正式下发拒绝',
      'PLM RDM 草稿配方工艺不能下发启用 MES 模型',
      'PLM CORE-DRAFT 未发布模型不能被生产计划引用',
      'PLM WIP 未发布模型不能被生产计划引用'], '生产计划引用反例不能替代已发布基线/工艺的完整业务门禁。')
    markPlmAssertion(caseRecord, 1, ['PLM EBOM 正式下发回读真实 MES BOM 草稿',
      'PLM MES API 回读版本来源数量且未冒充正式消费',
      'PLM 产品发布后状态映射和来源正式回读',
      'PLM RELEASED RDM MES 主档是专属启用 BOM 和工艺路线',
      'PLM RELEASED RDM 项目发布审计与物料默认 BOM 路线正式回读',
      'PLM MES 正式用料展开消费下发 BOM 工艺和真实数量',
      'PLM MES 正式转工单消费专属计划 BOM 且数量守恒',
      'PLM MES 工单实际物料清单保留源配方用量',
      'PLM MES 正式工单和试量产计划经项目关系 API 回流',
      'PLM 下发后生产计划正式 API 保存 BOM 引用'],
    `${PLM_CONTRACT_GAPS.baseline} ${PLM_CONTRACT_GAPS.consumption} ${PLM_CONTRACT_GAPS.approval}`)
    markPlmAssertion(caseRecord, 2, ['PLM 重复 EBOM 下发保持同 BOM 同子行与来源数量',
      'PLM 重复基线发布保留版本与首次发布时间',
      'PLM RDM 重复下发保持主子实体和首次发布审计幂等'])
    markPlmAssertion(caseRecord, 3, ['PLM 发布 B 版后 A 版源 EBOM 仍可追溯',
      'PLM B 版发布后 A 版零件版本及状态保留', 'PLM B 版正式下发有新版本用量与来源',
      'PLM B 版正式下发不覆盖 A 版 MES 历史', 'PLM 已下发 A 版 EBOM 禁止原位保存',
      'PLM 已下发 A 版拒绝原位保存后完整源行不变'],
    `${PLM_CONTRACT_GAPS.version} 已消费版本的物理删除保护尚无正式业务消费样本。`)
    caseRecord.notes.push('PLM-002 前置 PLM-001 尚未完整验收；本轮专属建模只能补充发布证据，不能替代该前置。')
  }
  let fixture
  try {
    if (caseId === 'PLM-001' && !knowledgeApi) {
      throw new Error('BLOCKED: PLM 知识引用缺少正文隔离客户端')
    }
    fixture = await createPlmModel({ api, caseRecord, ...dependencies })
    if (caseId === 'PLM-001') {
      await runPlmKnowledgeReference({ api, knowledgeApi, fixture, caseRecord })
      await runPlmStages({ api, fixture, caseRecord })
      await runPlmPermissions({ api, fixture, caseRecord, ...dependencies })
      caseRecord.notes.push('PLM-001 reverse 缺口：未执行草稿模型撤回；工艺没有同路线新版本入口，未把原地 update 当版本迭代。')
    } else {
      await runPlmRelease({ api, fixture, caseRecord })
      await runPlmMesRelease({ api, fixture, caseRecord })
    }
  } catch (error) {
    caseRecord.notes.push(`${caseId} 写侧中断：${error.message}`)
    throw error
  } finally {
    finalizePlmAssertions(caseRecord)
  }
  return { fixture, ...finalizePlmAssertions(caseRecord) }
}
