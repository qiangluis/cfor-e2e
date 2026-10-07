import { createApiClient } from '../lib/api.mjs'
import { nonEmpty } from '../lib/assertions.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['PLM-001', 'PLM-002']

export const strictList = (payload) => {
  const data = payload?.data
  const rows = Array.isArray(data) ? data : data?.list ?? data?.records
  if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row) || !Object.keys(row).length)) {
    throw new Error('PLM 列表响应不是 data 数组或 data.list/data.records 对象数组')
  }
  return rows
}

export const strictTree = (payload) => {
  const value = payload?.data
  const rows = Array.isArray(value) ? value : value?.children
  if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row) || !Object.keys(row).length)) {
    throw new Error('PLM 树响应不是有效 data 数组或 data.children 数组')
  }
  return rows
}

export const menuRoute = (menus, components) => {
  if (!Array.isArray(menus)) throw new Error('权限信息缺少菜单树')
  const normalize = (value) => String(value || '').split('?')[0]
    .replace(/^\/?(?:src\/)?views\//, '').replace(/^\/+/, '').replace(/\.vue$/, '').replace(/\/index$/, '')
  const wanted = new Set(components.map(normalize))
  const matches = new Set()
  const walk = (nodes, parent = '') => {
    for (const node of nodes) {
      if (!node || typeof node.path !== 'string') continue
      if (/^https?:\/\//.test(node.path)) continue
      const full = node.path.startsWith('/') ? node.path : `${parent}/${node.path}`.replace(/\/+/g, '/')
      if (wanted.has(normalize(node.component))) matches.add(full.split('?')[0])
      if (Array.isArray(node.children)) walk(node.children, full)
    }
  }
  walk(menus)
  const ordered = [...matches].sort((left, right) => {
    const score = (value) => (value.startsWith('/settings/') ? 3 : value.startsWith('/plm/') ? 2 : 1)
    return score(right) - score(left) || left.localeCompare(right)
  })
  return ordered[0] || null
}

export const releaseFacts = (baselines, logs) => {
  const released = baselines.filter((row) =>
    row.status === 'RELEASED' && row.id && nonEmpty(row.versionNo) && row.productId && row.releaseTime
  )
  return {
    released,
    receipts: logs.filter((row) =>
      row.operationType === 'release' && row.resultStatus === 'SUCCESS' &&
      row.mesReceived === true && row.targetMaterialId && nonEmpty(row.businessKey) &&
      released.some((baseline) => String(baseline.id) === String(row.baselineId) &&
        String(baseline.productId) === String(row.productId))
    ),
    partial: true
  }
}

const check = (caseRecord, name, passed, details) => caseRecord.checks.push({ name, passed, details })

const readList = async (api, caseRecord, path, label) => {
  const rows = strictList(await api.getBusiness(path))
  caseRecord.evidence.push(`${label}: GET ${path}; rows=${rows.length}（仅响应结构，不代表业务验收）`)
  if (!rows.length) caseRecord.notes.push(`缺前置：${label}当前查询为空，未进行该业务事实断言。`)
  return rows
}

const inspectRows = (caseRecord, label, rows, predicate) => {
  if (rows.length) check(caseRecord, label, rows.every(predicate), `sampleRows=${rows.length}; 仅当前查询样本`)
}

const view = async (api, page, record, caseRecord, outputDir, components, selector, name, dependencies) => {
  const permission = await api.getBusiness('/system/auth/get-permission-info')
  const route = components.map((component) => menuRoute(permission?.data?.menus, [component])).find(Boolean)
  if (!route) {
    caseRecord.notes.push(`缺前置：${name}权限菜单未找到唯一组件路由，未猜测旧路径。`)
    return
  }
  await (dependencies.openRoute || openRoute)(page, route, { readySelector: selector })
  check(caseRecord, `${name}真实页面控件就绪`, new URL(page.url()).pathname === route, page.url())
  await (dependencies.saveScreenshot || saveScreenshot)(page, outputDir, name, record)
  caseRecord.evidence.push(`${name}: permission menu -> ${route}; selector=${selector}`)
}

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }, dependencies = {}) => {
  if (!cases.includes(caseId)) return { designed: true }
  caseRecord.notes.push('只读前置门禁，不创建/审核/冻结/发布业务模型，不将空集或页面可见视为正式业务通过。')
  const token = await (dependencies.login || login)(page)
  const api = (dependencies.createApiClient || createApiClient)({ token, record })
  const products = await readList(api, caseRecord, '/plm/core/product/page?pageNo=1&pageSize=100', '产品主档')
  inspectRows(caseRecord, '产品样本包含主键、编号、生命周期', products,
    (row) => Boolean(row.id && row.productNo && row.lifecycleStatus))

  if (caseId === 'PLM-001') {
    const projects = await readList(api, caseRecord, '/plm/rdm/project/ledger/page?pageNo=1&pageSize=100', '研发项目')
    const parts = await readList(api, caseRecord, '/plm/core/part/page?pageNo=1&pageSize=100', '零件主档')
    const eboms = await readList(api, caseRecord, '/plm/core/ebom/page?pageNo=1&pageSize=100', 'EBOM')
    inspectRows(caseRecord, '研发项目样本保留阶段、状态与负责人', projects,
      (row) => Boolean(row.id && row.stageCode && row.status && row.ownerId))
    const product = products.find((row) => row.id && row.sourceProjectId)
    if (product) {
      const project = (await api.getBusiness(`/plm/rdm/project/ledger/get?id=${encodeURIComponent(product.sourceProjectId)}`)).data
      check(caseRecord, '产品来源研发项目可追溯', String(project?.id) === String(product.sourceProjectId),
        `product=${product.id}; sourceProject=${product.sourceProjectId}`)
      const tasks = await readList(api, caseRecord,
        `/plm/rdm/project/ledger/tasks?projectId=${encodeURIComponent(product.sourceProjectId)}`, '项目阶段任务')
      inspectRows(caseRecord, '阶段任务归属来源项目', tasks,
        (row) => String(row.projectId) === String(product.sourceProjectId))
    } else caseRecord.notes.push('缺前置：没有包含 sourceProjectId 的产品样本，未验证项目到产品来源链。')
    const part = parts.find((row) => row.id)
    if (part) {
      const revisions = await readList(api, caseRecord,
        `/plm/core/part/revision/page?pageNo=1&pageSize=100&partId=${encodeURIComponent(part.id)}`, '零件版本')
      inspectRows(caseRecord, '零件版本有版本号、状态且属于查询零件', revisions,
        (row) => String(row.partId) === String(part.id) && Boolean(row.revisionNo && row.revisionStatus))
    }
    const ebom = eboms.find((row) => row.ebomId || row.id)
    if (ebom) {
      const id = ebom.ebomId || ebom.id
      const tree = strictTree(await api.getBusiness(`/plm/core/ebom/tree?ebomId=${encodeURIComponent(id)}`))
      caseRecord.evidence.push(`EBOM 树: GET /plm/core/ebom/tree?ebomId=${id}; rows=${tree.length}（仅响应结构，不代表业务验收）`)
      if (!tree.length) caseRecord.notes.push(`缺前置：EBOM=${id}没有 BOM 行，版本链路未验证。`)
      inspectRows(caseRecord, 'EBOM 行引用零件版本且数量有效', tree,
        (row) => Boolean(row.componentPartId && row.componentRevisionId && row.partVersion) &&
          ['number', 'string'].includes(typeof row.quantity) && nonEmpty(row.quantity) &&
          Number.isFinite(Number(row.quantity)))
      await readList(api, caseRecord, `/plm/core/ebom/downstream-refs?ebomId=${encodeURIComponent(id)}`, 'EBOM 下游引用')
    }
    await view(api, page, record, caseRecord, outputDir,
      ['plm/product-part/product-ledger/index', 'plm/core/product-ledger/index'],
      '.plm-product-page input[placeholder="请输入产品编号"]', 'plm-001-product-prerequisites', dependencies)
    await view(api, page, record, caseRecord, outputDir,
      ['plm/project-rdm/project-ledger/index', 'plm/rdm/project/project-ledger/index'],
      '.el-form-item__label:has-text("项目状态")', 'plm-001-project-prerequisites', dependencies)
    caseRecord.notes.push(
      'PARTIAL：仅读取当前租户建模样本；尚缺 PMS 项目关联、完整阶段流转、工艺版本来源、两个成员权限身份与知识中枢引用/正文不复制证据。未创建或推进共享项目。'
    )
  } else {
    const baselines = await readList(api, caseRecord, '/plm/core/baseline/page?pageNo=1&pageSize=100', '配置基线')
    inspectRows(caseRecord, '基线样本保留主键、产品与状态', baselines,
      (row) => Boolean(row.id && row.productId && row.status))
    const missingVersions = baselines.filter((row) => !nonEmpty(row.versionNo))
    if (missingVersions.length) caseRecord.notes.push(
      `缺前置：基线 versionNo 为空，无法证明版本追溯；baselineIds=${missingVersions.map((row) => row.id).join(',')}。`
    )
    const facts = releaseFacts(baselines, [])
    if (!facts.released.length) caseRecord.notes.push('缺前置：没有同时保留版本、产品及发布时间的 RELEASED 基线。')
    const baseline = facts.released[0] || baselines.find((row) => row.id)
    if (baseline) {
      const detail = (await api.getBusiness(`/plm/core/baseline/get?id=${encodeURIComponent(baseline.id)}`)).data
      check(caseRecord, '基线详情与分页身份一致',
        String(detail?.id) === String(baseline.id),
        `baseline=${baseline.id}; version=${baseline.versionNo}`)
      if (nonEmpty(baseline.versionNo)) check(caseRecord, '非空基线版本在详情和分页保持一致',
        detail?.versionNo === baseline.versionNo, `baseline=${baseline.id}; version=${baseline.versionNo}`)
      const product = (await api.getBusiness(`/plm/core/product/get?id=${encodeURIComponent(baseline.productId)}`)).data
      check(caseRecord, '基线产品来源可读', String(product?.id) === String(baseline.productId),
        `baseline=${baseline.id}; product=${baseline.productId}`)
      if (!product?.targetMaterialId) caseRecord.notes.push('缺前置：基线产品尚未绑定 MES 目标物料。')
      const logs = await readList(api, caseRecord,
        `/plm/core/baseline/route-release-logs?baselineId=${encodeURIComponent(baseline.id)}&limit=20`, '既有路线发布日志')
      inspectRows(caseRecord, '日志归属查询基线', logs, (row) => String(row.baselineId) === String(baseline.id))
      const receipts = releaseFacts(baselines, logs).receipts
      caseRecord.evidence.push(`既有正式 release SUCCESS 日志（非 check/dryRun）=${receipts.length}; baseline=${baseline.id}`)
      if (!receipts.length) caseRecord.notes.push('缺前置：没有同时保留业务键、产品、目标物料及 MES 接收标志的正式发布记录。')
    }
    // route-context is a GET with persisted check logs; the release workbench invokes it automatically.
    await view(api, page, record, caseRecord, outputDir,
      ['plm/configuration-baseline/product-baseline/index', 'plm/core/baseline/index'],
      '.plm-baseline-page input[placeholder="请输入基线编号"]', 'plm-002-baseline-prerequisites', dependencies)
    caseRecord.notes.push(
      'PARTIAL：PLM-001 尚未完整 PASS；未验证未发布版本被 ERP/MES 拒绝、正式消费回执、重复发布幂等和历史版本保护。route-context 会持久化 check 日志，故不调用该 GET 或自动调用它的 CAPP 下发页。'
    )
  }
  return { token, api, partial: true }
}
