import { config } from '../config/index.mjs'
import { createApiClient } from '../lib/api.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { findMenuRouteByComponent, isStableId } from './base-partner.mjs'

export const cases = Object.freeze(['IOT-001'])
export const iotFoundationReadonlyBoundary =
  'IOT-001 仅验证只读前置，始终 PARTIAL；未测试产品/物模型/设备组/设备新增维护、' +
  '设备只写 iot_device、MES 主资源引用 IoT 设备、旧 MES 写侧拒绝及权限/跨租户反例'
export const iotFoundationViews = Object.freeze({
  product: {
    component: 'iot/product/product/index',
    readySelector: '.el-form-item:has-text("产品名称")',
    labels: ['产品名称', 'ProductKey']
  },
  group: {
    component: 'iot/device/group/index',
    readySelector: '.el-table__header-wrapper th:has-text("分组 ID")',
    headers: ['分组 ID', '分组名字', '分组状态', '设备数量']
  },
  device: {
    component: 'iot/device/device/index',
    readySelector: '.el-form-item:has-text("设备名称")',
    labels: ['产品', '设备名称', '所属部门', '设备分组']
  }
})

const object = (value) => value != null && typeof value === 'object' && !Array.isArray(value)
const text = (value) => typeof value === 'string' && value.trim().length > 0
const stable = (value) => isStableId(value) && String(value) === String(value).trim()
const sameId = (a, b) => stable(a) && stable(b) && String(a) === String(b)
const count = (value) => Number.isSafeInteger(value) && value >= 0
const data = (payload, label) => assertBusinessSuccess(payload, label).data
const fact = (record, name, passed, details = '') => {
  record.checks.push({ name, passed: Boolean(passed), details })
  if (!passed) throw new Error(`${name}：${details}`)
}
const missing = (record, details) =>
  record.notes.push(`前置缺失：${details}；不以空集生成字段、关联或物模型页面通过证据`)
const modelField = (type) => ({ 1: 'property', 2: 'service', 3: 'event' })[type]
const groupSet = (row) => Array.isArray(row.groupIds) &&
  row.groupIds.every(stable) && new Set(row.groupIds.map(String)).size === row.groupIds.length
const readonlyGet = (path) =>
  /^\/system\/auth\/get-permission-info$/.test(path) ||
  /^\/iot\/(?:product|thing-model|device-group|device)\/(?:page|get)\?/.test(path)

export function iotFoundationPage(payload, label) {
  const result = data(payload, label)
  if (!object(result) || !Array.isArray(result.list) || !count(result.total) ||
    result.total < result.list.length || result.list.length > 100 ||
    (!result.list.length && result.total !== 0) || !result.list.every(object)) {
    throw new Error(`${label} 必须返回有效首100条 data.list/total 分页`)
  }
  return result
}

// Audited 2026-10-06: these controllers call selectPage/selectById only.
// Group page adds selectCountByGroupId (FIND_IN_SET(group_ids)); no gateway,
// telemetry, scan, sync-property-table, credentials or MES write endpoint is used.
const bases = {
  product: '/iot/product', model: '/iot/thing-model',
  group: '/iot/device-group', device: '/iot/device'
}
async function getReadonly(api, path, label = path) {
  if (!readonlyGet(path)) throw new Error(`非只读 GET 被拒绝：${path}`)
  return api.getBusiness(path, label)
}
async function readPage(api, record, kind, filter = '') {
  const path = `${bases[kind]}/page?pageNo=1&pageSize=100${filter}`
  const result = iotFoundationPage(await getReadonly(api, path), path)
  fact(record, `${kind} 真实分页结构`, true,
    `rows=${result.list.length}, total=${result.total}；仅首100条`)
  if (!result.list.length) missing(record, `${kind}${filter} 没有真实记录`)
  if (result.list.length) {
    fact(record, `${kind} 分页稳定 ID 不重复`,
      result.list.every((row) => stable(row.id)) &&
        new Set(result.list.map((row) => String(row.id))).size === result.list.length)
  }
  return result
}

function validateRow(kind, row, record) {
  let passed = stable(row.id)
  if (kind === 'product') {
    passed &&= text(row.name) && text(row.productKey) &&
      [0, 1].includes(row.status) && [0, 1, 2].includes(row.deviceType)
  } else if (kind === 'model') {
    const definition = row[modelField(row.type)]
    passed &&= stable(row.productId) && text(row.productKey) &&
      text(row.name) && text(row.identifier) && [1, 2, 3].includes(row.type) &&
      object(definition) && definition.identifier === row.identifier &&
      definition.name === row.name
  } else if (kind === 'group') {
    passed &&= text(row.name) && [0, 1].includes(row.status)
  } else {
    passed &&= text(row.deviceName) && stable(row.productId) && text(row.productKey) &&
      [0, 1, 2].includes(row.deviceType) && [0, 1, 2].includes(row.state)
    if (row.groupIds != null) passed &&= groupSet(row)
  }
  fact(record, `${kind} 非空记录字段契约`, passed, `id=${row.id}`)
}

async function readDetail(api, record, kind, id, pageRow) {
  const path = `${bases[kind]}/get?id=${encodeURIComponent(id)}`
  const row = data(await getReadonly(api, path), path)
  fact(record, `${kind} 详情精确回读稳定 ID`, object(row) && sameId(row.id, id), `id=${id}`)
  validateRow(kind, row, record)
  if (pageRow) {
    const fields = {
      product: ['name', 'productKey', 'status', 'deviceType'],
      model: ['name', 'identifier', 'productKey', 'type'],
      group: ['name', 'status'],
      device: ['deviceName', 'productKey', 'deviceType']
    }[kind]
    fact(record, `${kind} 分页详情事实一致`,
      fields.every((field) => row[field] === pageRow[field]) &&
        (!['model', 'device'].includes(kind) || sameId(row.productId, pageRow.productId)),
      `id=${id}；瞬时回读，不证明写入或状态转移`)
    if (kind === 'device' && row.groupIds != null && pageRow.groupIds != null) {
      fact(record, '设备分页详情分组集合一致',
        JSON.stringify(row.groupIds.map(String).sort()) ===
          JSON.stringify(pageRow.groupIds.map(String).sort()), `deviceId=${id}`)
    }
  }
  return row
}

export async function runIotFoundationReadonlyContract({ api, caseRecord }) {
  caseRecord.notes.push(iotFoundationReadonlyBoundary,
    '源码快照：product/device DO 继承 TenantBaseDO；thing-model/device-group DO 继承 BaseDO，' +
    '本只读步骤不证明其租户隔离，不补 tenantId 字段或宣称隔离已验收',
    '仅首100条及每类最多10条详情/关联样本，未证明全量历史一致性')
  const pages = {}
  pages.product = await readPage(api, caseRecord, 'product')
  for (const row of pages.product.list) validateRow('product', row, caseRecord)

  // Thing-model pagination is scoped by a real product in the backend.
  const modelProduct = pages.product.list[0]
  if (modelProduct) {
    pages.model = await readPage(
      api, caseRecord, 'model', `&productId=${encodeURIComponent(modelProduct.id)}`
    )
    for (const row of pages.model.list) validateRow('model', row, caseRecord)
  } else {
    pages.model = { list: [], total: 0 }
    missing(caseRecord, '没有真实产品，未请求需要 productId 的物模型分页')
  }

  pages.group = await readPage(api, caseRecord, 'group')
  for (const row of pages.group.list) {
    validateRow('group', row, caseRecord)
    fact(caseRecord, '设备组列表真实设备数量', count(row.deviceCount), `groupId=${row.id}`)
  }

  pages.device = await readPage(api, caseRecord, 'device')
  for (const row of pages.device.list) validateRow('device', row, caseRecord)
  const products = new Map()
  const groups = new Map()
  const product = async (id) => {
    if (!products.has(String(id))) {
      products.set(String(id), await readDetail(api, caseRecord, 'product', id,
        pages.product.list.find((row) => sameId(row.id, id))))
    }
    return products.get(String(id))
  }
  const group = async (id) => {
    if (!groups.has(String(id))) {
      groups.set(String(id), await readDetail(api, caseRecord, 'group', id,
        pages.group.list.find((row) => sameId(row.id, id))))
    }
    return groups.get(String(id))
  }
  for (const row of pages.product.list.slice(0, 10)) await product(row.id)
  let modelSample = null
  for (const row of pages.model.list.slice(0, 10)) {
    const detail = await readDetail(api, caseRecord, 'model', row.id, row)
    const parent = await product(detail.productId)
    fact(caseRecord, '物模型 productId/productKey 精确引用真实产品',
      sameId(detail.productId, parent.id) && detail.productKey === parent.productKey,
      `modelId=${detail.id}, productId=${parent.id}`)
    modelSample ||= {
      productId: parent.id,
      productKey: parent.productKey,
      productName: parent.name,
      identifier: detail.identifier
    }
  }
  let memberships = 0
  for (const row of pages.device.list.slice(0, 10)) {
    const detail = await readDetail(api, caseRecord, 'device', row.id, row)
    const parent = await product(detail.productId)
    fact(caseRecord, '设备 productId/productKey 精确引用真实产品',
      sameId(detail.productId, parent.id) && detail.productKey === parent.productKey,
      `deviceId=${detail.id}, productId=${parent.id}；不证明历史设备类型快照随产品变更`)
    if (detail.groupIds == null || !detail.groupIds.length) {
      missing(caseRecord, `设备 ${detail.id} 无分组成员事实`)
      continue
    }
    for (const id of detail.groupIds) {
      const parentGroup = await group(id)
      fact(caseRecord, '设备 groupIds 精确引用真实设备组',
        sameId(parentGroup.id, id), `deviceId=${detail.id}, groupId=${id}`)
      memberships++
    }
  }
  for (const row of pages.group.list.slice(0, 10)) {
    await group(row.id)
    const members = await readPage(api, caseRecord, 'device',
      `&groupId=${encodeURIComponent(row.id)}`)
    fact(caseRecord, '设备组 deviceCount 与 groupId 过滤 total 一致',
      members.total === row.deviceCount, `groupId=${row.id}, total=${members.total}`)
    for (const member of members.list) {
      validateRow('device', member, caseRecord)
      fact(caseRecord, 'groupId 过滤只返回真实分组成员',
        groupSet(member) && member.groupIds.some((id) => sameId(id, row.id)),
        `groupId=${row.id}, deviceId=${member.id}`)
    }
  }
  if (!memberships) missing(caseRecord, '抽样内无设备→设备组关联，成员正向关联尚未验证')
  return { partial: true, note: iotFoundationReadonlyBoundary, modelSample }
}

const pathnameMatches = (page, route) =>
  new URL(page.url()).pathname === new URL(route, config.webBase).pathname

function menuRoutesByComponent(menus, component, parentPath = '') {
  const routes = []
  for (const menu of Array.isArray(menus) ? menus : []) {
    const path = String(menu?.path || '').trim()
    const routePath = path.startsWith('/')
      ? path
      : [parentPath.replace(/\/$/, ''), path.replace(/^\//, '')]
        .filter(Boolean).join('/')
    if (menu?.component === component) routes.push(`/${routePath.replace(/^\/+/, '')}`)
    routes.push(...menuRoutesByComponent(menu?.children, component, routePath))
  }
  return routes
}

export async function runIotFoundationReadonlyCase(
  { caseId, page, record, caseRecord, outputDir }, dependencies = {}
) {
  if (caseId !== 'IOT-001') throw new Error(`非目标 IoT 基础只读案例：${caseId}`)
  if (config.target !== 'local') throw new Error('BLOCKED: IOT-001 只允许本地测试环境')
  const helpers = { login, createApiClient, openRoute, saveScreenshot, ...dependencies }
  const token = await helpers.login(page)
  fact(caseRecord, '真实登录成功', Boolean(token))
  const api = helpers.createApiClient({ token, record })
  const permission = data(await getReadonly(
    api, '/system/auth/get-permission-info', '权限菜单'), '权限菜单')
  if (!Array.isArray(permission?.menus)) throw new Error('权限响应 data.menus 必须为数组')
  const routes = {}
  for (const [kind, view] of Object.entries(iotFoundationViews)) {
    const candidates = menuRoutesByComponent(permission.menus, view.component)
    const preferredPath = {
      product: '/iot/device/product',
      group: '/iot/device/group',
      device: '/iot/device/device'
    }[kind]
    routes[kind] = candidates.find((route) => route === preferredPath) ||
      findMenuRouteByComponent(permission.menus, view.component)
    if (!routes[kind] || !/^\/(?:iot|settings\/iot)\//.test(routes[kind])) {
      throw new Error(`BLOCKED: 权限菜单无有效 IoT component=${view.component}`)
    }
  }
  const result = await runIotFoundationReadonlyContract({ api, caseRecord })
  const screenshot = async (suffix) => {
    caseRecord.evidence.push(
      await helpers.saveScreenshot(page, outputDir, `IOT-001-${suffix}`, record))
  }
  for (const [kind, view] of Object.entries(iotFoundationViews)) {
    await helpers.openRoute(page, routes[kind], { readySelector: view.readySelector })
    const labels = await page.locator(view.headers
      ? '.el-table__header-wrapper th' : '.el-form-item__label').allInnerTexts()
    fact(caseRecord, `${kind} 真实菜单领域界面`,
      pathnameMatches(page, routes[kind]) && (view.headers || view.labels)
        .every((expected) => labels.some((label) => label.trim() === expected)),
      `component=${view.component}, route=${routes[kind]}；仅界面，不代表非空业务事实`)
    await screenshot(kind)
  }
  if (!result.modelSample) {
    missing(caseRecord, '没有真实物模型及产品关联，未打开独立 thingmodel 空壳或伪造详情 ID')
    return { token, api, ...result }
  }
  // The standalone thingmodel view injects PRODUCT, so use the real product entry.
  const sample = result.modelSample
  await helpers.openRoute(page, routes.product, {
    readySelector: iotFoundationViews.product.readySelector
  })
  await page.getByPlaceholder('请输入产品标识', { exact: true }).fill(sample.productKey)
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  // ProductKey is ellipsized in the card UI; use the exact product name after
  // filtering by ProductKey so the card remains uniquely tied to the API row.
  const card = page.locator('.el-row .el-card').filter({
    hasText: sample.productName
  })
  await card.first().waitFor({ state: 'visible', timeout: 30000 })
  fact(caseRecord, '产品入口精确定位唯一 ProductKey 卡片', await card.count() === 1,
    `productId=${sample.productId}`)
  await card.getByRole('button', { name: '物模型', exact: true }).click()
  const detailPath = `/iot/product/product/detail/${encodeURIComponent(sample.productId)}`
  await page.waitForURL((url) =>
    url.pathname === detailPath && url.searchParams.get('tab') === 'thingModel')
  const pane = page.locator('#pane-thingModel')
  await pane.locator('.el-table__header-wrapper th:has-text("标识符")').waitFor({
    state: 'visible', timeout: 30000
  })
  const headers = await pane.locator('.el-table__header-wrapper th').allInnerTexts()
  fact(caseRecord, '真实产品入口打开物模型功能定义页',
    pathnameMatches(page, detailPath) &&
      ['功能类型', '功能名称', '标识符', '数据定义'].every((expected) =>
        headers.some((header) => header.trim() === expected)),
    `productId=${sample.productId}；详情参数来自真实关联，不用 catalog 伪路由`)
  await screenshot('thing-model')
  return { token, api, ...result }
}

export const runCase = runIotFoundationReadonlyCase
