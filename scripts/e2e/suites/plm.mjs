import { createApiClient } from '../lib/api.mjs'
import { nonEmpty } from '../lib/assertions.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { config } from '../config/index.mjs'
import {
  assertPlmLocalTarget, createPlmKnowledgeApi, runPlmWriteClosure
} from '../fixtures/plm-write-closure.mjs'

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

const view = async (api, page, record, caseRecord, outputDir, components, selector, name, dependencies, sample) => {
  const permission = await api.getBusiness('/system/auth/get-permission-info')
  const route = components.map((component) => menuRoute(permission?.data?.menus, [component])).find(Boolean)
  if (!route) {
    caseRecord.notes.push(`缺前置：${name}权限菜单未找到唯一组件路由，未猜测旧路径。`)
    return false
  }
  await (dependencies.openRoute || openRoute)(page, route, { readySelector: selector })
  check(caseRecord, `${name}真实页面控件就绪`, new URL(page.url()).pathname === route, page.url())
  if (sample) {
    await page.getByPlaceholder(sample.placeholder, { exact: true }).first().fill(sample.value)
    await page.getByRole('button', { name: '搜索', exact: true }).first().click()
    const ownedRow = page.locator('.el-table__row').filter({ hasText: sample.value }).first()
    await ownedRow.waitFor({ state: 'visible', timeout: 30000 })
    check(caseRecord, `${name}展示本轮专属样本`,
      (await ownedRow.innerText()).includes(sample.value), `fixture=${sample.value}`)
  }
  await (dependencies.saveScreenshot || saveScreenshot)(page, outputDir, name, record)
  caseRecord.evidence.push(`${name}: permission menu -> ${route}; selector=${selector}`)
  return true
}

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }, dependencies = {}) => {
  if (!cases.includes(caseId)) return { designed: true }
  const runtime = dependencies.runtime || config
  // Check the service origin before touching the shared browser session.
  assertPlmLocalTarget({ ...runtime, tenantId: runtime.tenantId || '1' })
  const auth = await (dependencies.login || login)(page, { returnContext: true })
  const token = auth?.token
  const tenantId = auth?.tenantId
  if (!token || !tenantId) throw new Error('BLOCKED: PLM 登录缺少可验证的 token/tenantId 上下文')
  const verifiedRuntime = { ...runtime, tenantId }
  assertPlmLocalTarget(verifiedRuntime)
  const apiFactory = dependencies.createApiClient || createApiClient
  const api = apiFactory({ token, tenantId, record })
  const knowledgeApi = createPlmKnowledgeApi({ token, tenantId, record, apiFactory })
  caseRecord.notes.push('本地专属写侧：只创建本轮 E2E-PLM 标记的数据，临时成员账号最终停用；缺少正式契约保留 GAP，意外放行记录 FAIL。')
  const result = await (dependencies.runPlmWriteClosure || runPlmWriteClosure)({
    caseId, api, knowledgeApi, caseRecord, record, runtime: verifiedRuntime, apiFactory,
    ...(dependencies.writeSafety ? { writeSafety: dependencies.writeSafety } : {}),
    ...(dependencies.tokenFactory ? { tokenFactory: dependencies.tokenFactory } : {})
  })
  const fixture = result.fixture
  const productVisible = await view(api, page, record, caseRecord, outputDir,
    ['plm/product-part/product-ledger/index', 'plm/core/product-ledger/index'],
    '.plm-product-page input[placeholder="请输入产品编号"]', `${caseId.toLowerCase()}-product-write`, dependencies,
    { placeholder: '请输入产品编号', value: fixture.productNo })
  let secondVisible
  if (caseId === 'PLM-001') {
    secondVisible = await view(api, page, record, caseRecord, outputDir,
      ['plm/project-rdm/project-ledger/index', 'plm/rdm/project/project-ledger/index'],
      '.el-form-item__label:has-text("项目状态")', 'plm-001-project-write', dependencies,
      { placeholder: '请输入单号', value: fixture.projectBody.bizNo })
  } else {
    // route-context is a GET with persisted check logs; the release workbench invokes it automatically.
    secondVisible = await view(api, page, record, caseRecord, outputDir,
      ['plm/configuration-baseline/product-baseline/index', 'plm/core/baseline/index'],
      '.plm-baseline-page input[placeholder="请输入基线编号"]', 'plm-002-baseline-write', dependencies)
    if (!fixture.baselineId) caseRecord.notes.push('基线页只验证控件，不把共享列表或空集作为本轮专属基线发布证据。')
  }
  const uiComplete = productVisible && secondVisible
  if (!uiComplete) {
    // The runner also inspects catalogAssertions, so a return flag alone is insufficient.
    for (const assertion of caseRecord.catalogAssertions || []) {
      assertion.status = 'GAP'
      assertion.details = `${assertion.details || ''} 本轮真实页面验收缺少权限路由证据。`.trim()
    }
    caseRecord.catalogComplete = false
    caseRecord.remainingAssertions = (caseRecord.catalogAssertions || []).map((row) => row.assertion)
  }
  return { token, api, ...result,
    partial: result.partial || !uiComplete,
    acceptanceComplete: result.acceptanceComplete === true && uiComplete &&
      caseRecord.checks.every((item) => item.passed === true),
    note: caseRecord.notes.join('；') }
}
