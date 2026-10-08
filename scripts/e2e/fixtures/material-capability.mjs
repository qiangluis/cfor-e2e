import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { config } from '../config/index.mjs'
import { createApiClient, apiHealth } from '../lib/api.mjs'
import { asList, assertBusinessSuccess } from '../lib/assertions.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { launchBrowser, login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { findMenuRouteByComponent } from '../suites/base-partner.mjs'
import { addCheck, caseOutcome, createCaseRecord, createRunRecord, ensureDir, finishCase, writeReport } from '../lib/report.mjs'

export const cases = Object.freeze(['PB032-006'])
const data = (body) => assertBusinessSuccess(body, 'material capability API').data
const fields = ['id', 'code', 'name', 'remark', 'unitId', 'inventoryNature', 'source',
  'purchased', 'saled', 'produced', 'isMaterial', 'parented', 'assembled', 'defaultProdBom',
  'leadTime', 'bufferTime', 'isEnabled', 'batchManaged', 'gradeManaged', 'periodManaged']
const snapshot = (row) => Object.fromEntries(fields.map((field) => [field, row?.[field] ?? null]))
const fact = (record, label, passed, details) => {
  addCheck(record, label, passed, JSON.stringify(details))
  if (!passed) throw new Error(`Assertion failed: ${label}`)
}
export function exactId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Unsafe fixture ID')
  if (!/^[1-9]\d*$/.test(String(value ?? ''))) throw new Error('Invalid fixture ID')
  return String(value)
}
export function assertScope(settings = config) {
  if (settings.target !== 'local' || String(settings.tenantId) !== '1' ||
      settings.tenantName !== 'CFOR 标准平台' || settings.db?.name !== 'cfor_admin_standard') {
    throw new Error('BLOCKED: material capability requires local tenant1/CFOR 标准平台/cfor_admin_standard')
  }
  for (const [base, port] of [[settings.apiBase, '48083'], [settings.webBase, '9151']]) {
    const url = new URL(base)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.port !== port || url.username || url.password) throw new Error('BLOCKED: local endpoints required')
  }
}
export function materialBody(unitId, code, marker, component = false) {
  exactId(unitId)
  if (!/^E2E-PB032006-[A-Z0-9-]+$/.test(code) || !code.startsWith(`${marker}-`)) {
    throw new Error('BLOCKED: material ownership marker required')
  }
  return {
    code, name: code, unitId: String(unitId), remark: marker,
    isEnabled: 1, inventoryNature: 'STOCK', virtualGoods: 'N', source: 'mixed',
    purchased: 'Y', saled: 'Y', produced: 'Y', parented: component ? 'N' : 'Y',
    isMaterial: component ? 'Y' : 'N', assembled: 'N', soned: 'N',
    batchManaged: 'N', oneBarcode: 'N', periodManaged: 'N', gradeManaged: 'N',
    colorManaged: 'N', brandManaged: 'N', backflush: 'N',
    leadTime: 1, bufferTime: 1, refPrice: 88.8, refCost: 50
  }
}
export function orderBody(kind, marker, material, partnerId) {
  if (!['purchase', 'sale'].includes(kind)) throw new Error('Invalid order kind')
  const orderTime = new Date().toISOString().slice(0, 19)
  return {
    billNo: `${marker}-${kind === 'purchase' ? 'PO' : 'SO'}`, type: 0,
    [kind === 'purchase' ? 'supplierId' : 'customerId']: exactId(partnerId),
    orderTime, billDate: orderTime.slice(0, 10),
    discountPercent: 0, discountPrice: 0, depositPrice: 0,
    totalCount: 1, totalProductPrice: 88.8, totalTaxPrice: 0, totalPrice: 88.8,
    remark: marker,
    items: [{ entryNo: 1, productId: exactId(material.id), productUnitId: exactId(material.unitId),
      productPrice: 88.8, productTaxPrice: 88.8, count: 1, taxPercent: 0,
      totalPrice: 88.8, taxPrice: 0, remark: marker }]
  }
}
export function isOpenBusinessReference(reference = {}) {
  return Number(reference.isClosed ?? reference[2] ?? 0) === 0 &&
    Number(reference.isVoided ?? reference[3] ?? 0) === 0 &&
    String(reference.billStage ?? reference[4] ?? '') !== '34'
}
const resources = {
  material: { table: 'mes_bas_material', identity: 'code', marker: 'remark',
    create: '/mes/basMaterial/add', get: '/mes/basMaterial/queryById', remove: '/mes/basMaterial/delete',
    children: [['mes_bas_material_property', 'material_id']] },
  partner: { table: 'base_partner', identity: 'name', marker: 'remark',
    create: '/base/partner/create', get: '/base/partner/get', remove: '/base/partner/delete', children: [] },
  purchase: { table: 'erp_purchase_order', identity: 'bill_no', marker: 'remark',
    create: '/erp/purchase-order/create', get: '/erp/purchase-order/get', remove: '/erp/purchase-order/delete',
    children: [['erp_purchase_order_items', 'mid']] },
  sale: { table: 'erp_sale_order', identity: 'bill_no', marker: 'remark',
    create: '/erp/sale-order/create', get: '/erp/sale-order/get', remove: '/erp/sale-order/delete',
    children: [['erp_sale_order_items', 'mid'], ['erp_sale_order_bom', 'mid']] },
  bom: { table: 'mes_wms_assemble', identity: 'code', marker: 'mark',
    create: '/mes/wmsAssemble/add', get: '/mes/wmsAssemble/queryById', remove: '/mes/wmsAssemble/delete',
    children: [['mes_wms_assemble_sub', 'parent_id']] },
  production: { table: 'mes_prod_order', identity: 'bill_no', marker: 'remark',
    create: '/mes/prodOrder/add', get: '/mes/prodOrder/queryById', remove: '/mes/prodOrder/delete',
    children: [['mes_prod_order_sub', 'mid'], ['mes_prod_order_material', 'mid']] }
}
export class MaterialCapabilityFixtures {
  constructor(api, record, sql = runReadOnlySql) {
    this.api = api
    this.record = record
    this.sql = sql
    this.marker = `E2E-PB032006-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`
    this.owned = []
    record.fixtures = this.owned
  }
  async query(stage, sql) {
    const result = await this.sql(sql)
    if (!result.available) throw new Error(`BLOCKED: ${result.reason}`)
    this.record.database = [...(this.record.database || []), { stage, ...result }]
    return result.rows
  }
  async ownership(resource) {
    const meta = resources[resource.kind]
    exactId(resource.id)
    const rows = await this.query(`ownership-${resource.kind}`,
      `SELECT id,tenant_id,${meta.identity},${meta.marker} FROM ${meta.table}
       WHERE tenant_id=1 AND deleted=0 AND id='${resource.id}'`)
    if (rows.length !== 1 || rows[0][0] !== resource.id || rows[0][1] !== '1' ||
        rows[0][2] !== resource.identity || rows[0][3] !== this.marker) {
      throw new Error(`BLOCKED: ownership mismatch ${resource.kind}/${resource.id}`)
    }
    return resource
  }
  async create(kind, body) {
    const meta = resources[kind]
    const identity = body[meta.identity === 'bill_no' ? (kind === 'production' ? 'prodNo' : 'billNo') : meta.identity]
    if (!/^[A-Z0-9-]+$/.test(identity || '') || !identity.startsWith(`${this.marker}-`) ||
        body[meta.marker] !== this.marker) throw new Error('BLOCKED: exclusive ownership required')
    const resource = { kind, identity, tenantId: '1', marker: this.marker, status: 'creating',
      ...(kind === 'bom' ? { parentId: exactId(body.stockId) } : {}) }
    this.owned.push(resource)
    try {
      resource.id = exactId(data(await this.api.postBusiness(meta.create, body)))
    } catch (error) {
      // Recover only exact owned facts if a response failed after a successful commit.
      const rows = await this.query(`recover-${kind}`,
        `SELECT id FROM ${meta.table} WHERE tenant_id=1 AND deleted=0
         AND ${meta.identity}='${identity}' AND ${meta.marker}='${this.marker}'`)
      if (rows.length === 1) resource.id = exactId(rows[0][0])
      if (rows.length > 1) throw new Error(`BLOCKED: ambiguous owned recovery ${kind}`)
      if (rows.length === 0) resource.status = 'not-created'
      throw error
    }
    await this.ownership(resource)
    resource.status = 'created'
    this.record.evidence.push(`${kind}: id=${resource.id}; marker=${this.marker}`)
    return resource
  }
  async read(resource) {
    await this.ownership(resource)
    return data(await this.api.getBusiness(`${resources[resource.kind].get}?id=${resource.id}`))
  }
  async materialState(resource, stage) {
    const api = await this.read(resource)
    const database = await this.query(stage,
      `SELECT id,code,purchased,saled,produced,is_material,parented,assembled,source,
       inventory_nature,unit_id,COALESCE(default_prod_bom,''),lead_time,buffer_time
       FROM mes_bas_material WHERE tenant_id=1 AND deleted=0 AND id='${resource.id}'`)
    return { api: snapshot(api), database }
  }
  async reject(resource, field, capability) {
    const before = await this.materialState(resource, `before-${field}`)
    const body = await this.read(resource)
    if (body[field] !== 'Y') throw new Error(`BLOCKED: fixture capability ${field} is not enabled`)
    await this.ownership(resource)
    const response = await this.api.request('PUT', '/mes/basMaterial/edit', { ...body, [field]: 'N' })
    const after = await this.materialState(resource, `after-${field}`)
    const proof = { materialId: resource.id, field, attempted: 'N', response, before, after }
    this.record.capabilityAttempts = [...(this.record.capabilityAttempts || []), proof]
    const unchanged = JSON.stringify(before) === JSON.stringify(after)
    fact(this.record, `${field} 拒绝后 API/DB 业务字段未变化`, unchanged, proof)
    fact(this.record, `${field} 命中引用保护而非来源/参数校验`,
      response?.code === 2010100009 &&
      String(response.msg || response.message).includes('仍被未完成业务引用') &&
      String(response.msg || response.message).includes(capability), proof)
    return proof
  }
  async cleanup() {
    const failures = []
    const priority = ['production', 'sale', 'purchase', 'bom', 'material', 'partner']
    for (const resource of [...this.owned].sort((a, b) => priority.indexOf(a.kind) - priority.indexOf(b.kind))) {
      if (!resource.id) {
        if (resource.status !== 'not-created') failures.push(`${resource.kind}: unresolved create response; owned recovery required`)
        continue
      }
      try {
        await this.ownership(resource)
        if (resource.kind === 'bom') {
          const parent = this.owned.find((row) => row.kind === 'material' && row.id === resource.parentId)
          if (!parent) throw new Error('BLOCKED: missing owned BOM parent')
          const material = await this.read(parent)
          if (String(material.defaultProdBom || '') === resource.id) {
            await this.ownership(parent)
            data(await this.api.putBusiness('/mes/basMaterial/edit', { ...material, defaultProdBom: '' }))
            const cleared = await this.read(parent)
            fact(this.record, '正式解除专属母件默认 BOM 引用', !cleared.defaultProdBom,
              { parentId: parent.id, bomId: resource.id, defaultProdBom: cleared.defaultProdBom })
          }
        }
        await this.ownership(resource)
        const meta = resources[resource.kind]
        if (resource.kind === 'purchase' || resource.kind === 'sale') {
          const detail = await this.read(resource)
          const shouldVoid = String(detail?.billStage || '') !== '12' ||
            Number(detail?.isEffective || 0) !== 0 ||
            Number(detail?.isClosed || 0) !== 0
          if (shouldVoid) {
            const voidPath = resource.kind === 'purchase'
              ? '/erp/purchase-order/void'
              : '/erp/sale-order/void'
            const voided = data(await this.api.putBusiness(voidPath, { id: resource.id }))
            const afterVoid = await this.read(resource)
            fact(this.record, `${resource.kind} 通过正式作废接口回到编制态`,
              String(afterVoid?.billStage || '') === '12' &&
              Number(afterVoid?.isEffective || 0) === 0 &&
              Number(afterVoid?.isClosed || 0) === 0,
              { id: resource.id, response: voided, afterVoid })
          }
        }
        const parameter = ['purchase', 'sale'].includes(resource.kind) ? 'ids' : 'id'
        data(await this.api.deleteBusiness(`${meta.remove}?${parameter}=${resource.id}`))
        const response = await this.api.get(`${meta.get}?id=${resource.id}`)
        const absent = ['material', 'bom', 'production'].includes(resource.kind)
          ? response?.success === false && (response.message || response.msg) === '未找到对应数据'
          : assertBusinessSuccess(response, 'cleanup readback').data == null
        fact(this.record, `${resource.kind} 正式删除后 API 回读不存在`, absent, { id: resource.id, response })
        const counts = await this.query(`cleanup-${resource.kind}`, [
          [meta.table, 'id'], ...meta.children
        ].map(([table, column]) => `SELECT '${table}',COUNT(*) FROM ${table}
          WHERE tenant_id=1 AND deleted=0 AND ${column}='${resource.id}'`).join(';'))
        fact(this.record, `${resource.kind} 主表及明细活动记录清零`,
          counts.length === 1 + meta.children.length && counts.every((row) => row[1] === '0'), counts)
        resource.status = 'cleaned'
      } catch (error) {
        resource.cleanupError = String(error.message)
        failures.push(`${resource.kind}/${resource.id}: ${error.message}`)
      }
    }
    this.record.cleanup = { passed: failures.length === 0, failures }
    fact(this.record, 'finally 专属实体正式清理完成', failures.length === 0, this.record.cleanup)
  }
}
const catalogDefinition = () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const definition = catalog.suites.flatMap((suite) => suite.cases).find((row) => row.id === cases[0])
  if (definition?.assertions?.length !== 5) throw new Error('PB032-006 catalog contract changed')
  return definition
}
export function mapCatalog(record, verified = new Set(), gaps = {}) {
  const definition = catalogDefinition()
  record.catalogAssertions = definition.assertions.map((assertion, index) => ({
    index, assertion, status: verified.has(index) ? 'VERIFIED' : 'GAP', reason: gaps[index] || ''
  }))
  record.remainingAssertions = record.catalogAssertions.filter((row) => row.status === 'GAP')
  record.readyCandidate = record.remainingAssertions.length === 0 && record.cleanup?.passed === true &&
    record.checks.length > 0 && record.checks.every((row) => row.passed)
}
async function verifyPage(context, fixtures, material) {
  const { page, caseRecord, outputDir, record } = context
  const permission = data(await fixtures.api.getPermissionInfo())
  const route = findMenuRouteByComponent(permission?.menus, 'base/material/index')
  if (!route) throw new Error('BLOCKED: permission menus do not expose component=base/material/index')
  await openRoute(page, route, { readySelector: 'input[placeholder="请输入存货编码"]' })
  await page.getByPlaceholder('请输入存货编码', { exact: true }).fill(material.identity)
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByRole('button', { name: material.identity, exact: true }).first().click()
  const dialog = page.locator('.el-dialog:visible').filter({ has: page.locator('.material-form-shell') }).last()
  await dialog.waitFor({ state: 'visible' })
  const capabilities = {}
  for (const label of ['可采购', '可销售', '可生产', '是否成品', '是否物料']) {
    const formItem = dialog.locator('.el-form-item').filter({
      has: page.locator('.el-form-item__label').getByText(label, { exact: true })
    }).first()
    await formItem.waitFor({ state: 'visible' })
    capabilities[label] = await formItem.locator('input[type=checkbox]').isChecked()
  }
  fact(caseRecord, '专属存货编辑页真实读取采购/销售/生产/BOM能力',
    capabilities['可采购'] && capabilities['可销售'] && capabilities['可生产'] && capabilities['是否成品'],
    { code: material.identity, capabilities })
  caseRecord.evidence.push(await saveScreenshot(page, outputDir, 'PB032-006-capabilities', record))
  await dialog.getByRole('button', { name: /取\s*消/ }).last().click()
  const pageResult = data(await fixtures.api.getBusiness(
    `/mes/basMaterial/list?pageNo=1&pageSize=100&code=${material.identity}`))
  const row = asList(pageResult).find((item) => String(item.id) === material.id)
  fact(caseRecord, '档案列表接口返回专属存货能力字段',
    row?.purchased === 'Y' && row?.saled === 'Y' && row?.produced === 'Y', { row: snapshot(row) })
  caseRecord.evidence.push(`真实权限菜单存货路由 ${route}; component=base/material/index`)
}
export async function runCase(context, dependencies = {}) {
  const { caseId, caseRecord, record, page } = context
  if (caseId !== cases[0] || caseRecord.id !== caseId) throw new Error('BLOCKED: exact PB032-006 case required')
  const settings = dependencies.config || config
  assertScope(settings)
  const verified = new Set()
  const gaps = {}
  mapCatalog(caseRecord)
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
  const auth = await (dependencies.login || login)(page, { returnContext: true })
  if (String(auth.tenantId) !== '1') throw new Error('BLOCKED: actual login tenant is not tenant1')
  record.environment.tenantId = '1'
  const api = (dependencies.createApiClient || createApiClient)({ token: auth.token, tenantId: '1', record })
  const fixtures = new MaterialCapabilityFixtures(api, caseRecord, dependencies.runReadOnlySql || runReadOnlySql)
  const attempt = async (indexes, operation) => {
    try {
      await operation()
      for (const index of indexes) verified.add(index)
    } catch (error) {
      for (const index of indexes) gaps[index] = String(error.message)
      caseRecord.notes.push(`GAP ${indexes.join(',')}: ${error.message}`)
    }
  }
  try {
    const templates = asList(data(await api.getBusiness('/mes/basMaterial/list/enabled')))
    const template = templates.find((row) => /^[1-9]\d*$/.test(String(row.unitId || '')))
    if (!template) throw new Error('BLOCKED: no valid existing unit; no material created')
    const parent = await fixtures.create('material', materialBody(template.unitId, `${fixtures.marker}-FG`, fixtures.marker))
    const component = await fixtures.create('material', materialBody(template.unitId, `${fixtures.marker}-RM`, fixtures.marker, true))
    const material = await fixtures.read(parent)
    await attempt([0], () => (dependencies.verifyPage || verifyPage)(context, fixtures, parent))
    for (const [kind, index, field, capability] of [
      ['purchase', 1, 'purchased', '可采购能力'], ['sale', 2, 'saled', '可销售能力']
    ]) {
      await attempt([index], async () => {
        const body = orderBody(kind, fixtures.marker, material, '1')
        if (kind === 'purchase') {
          const permissions = data(await api.getPermissionInfo())
          if (!(permissions.permissions || []).some((permission) =>
            ['*:*:*', 'erp:purchase-order:direct-create'].includes(permission))) {
            throw new Error('BLOCKED: no existing direct-create permission; no purchase partner/order created')
          }
          body.directCreate = 1
          body.directCreateReason = `${fixtures.marker} isolated capability protection`
        }
        const partner = await fixtures.create('partner', {
          name: `${fixtures.marker}-${kind === 'purchase' ? 'SUP' : 'CUS'}`,
          shortName: fixtures.marker, partnerKind: 'ORGANIZATION', status: 'ACTIVE',
          customerEnabled: kind === 'sale', supplierEnabled: kind === 'purchase',
          carrierEnabled: false, remark: fixtures.marker
        })
        body[kind === 'purchase' ? 'supplierId' : 'customerId'] = partner.id
        await fixtures.ownership(parent)
        await fixtures.ownership(partner)
        const order = await fixtures.create(kind, body)
        const orderDetail = await fixtures.read(order)
        const refs = await fixtures.query(`open-${kind}`,
          `SELECT bill.id,item.product_id,COALESCE(bill.is_closed,0),COALESCE(bill.is_voided,0),
           COALESCE(bill.bill_stage,'') FROM erp_${kind}_order bill
           JOIN erp_${kind}_order_items item ON item.mid=bill.id
           WHERE bill.tenant_id=1 AND item.tenant_id=1 AND bill.deleted=0 AND item.deleted=0
           AND bill.id='${order.id}' AND item.product_id='${parent.id}'`)
        fact(caseRecord, `专属未完成${kind}订单及物料关系真实存在`,
          refs.length === 1 && isOpenBusinessReference(refs[0]) &&
          asList(orderDetail?.items).some((row) => String(row.productId) === parent.id), { orderId: order.id, refs })
        await fixtures.reject(parent, field, capability)
      })
    }
    let bom
    await attempt([4], async () => {
      await fixtures.ownership(parent)
      await fixtures.ownership(component)
      bom = await fixtures.create('bom', {
        code: `${fixtures.marker}-BOM`, stockId: parent.id, stockCount: 1,
        version: '1', versionDesc: fixtures.marker, defaultRecord: 'N',
        bomUsage: 'PRODUCTION', unitId: material.unitId, mark: fixtures.marker,
        wmsAssembleSubList: [{ stockId: component.id, subStockCount: 1,
          unitId: material.unitId, lossRate: 0, mark: fixtures.marker }]
      })
      const refs = await fixtures.query('production-bom-references',
        `SELECT main.id,main.stock_id,main.bom_usage,sub.stock_id FROM mes_wms_assemble main
         JOIN mes_wms_assemble_sub sub ON sub.parent_id=main.id
         WHERE main.tenant_id=1 AND sub.tenant_id=1 AND main.deleted=0 AND sub.deleted=0 AND main.id='${bom.id}'`)
      fact(caseRecord, '生产 BOM 专属母子件引用真实存在',
        refs.length === 1 && refs[0][1] === parent.id && refs[0][2] === 'PRODUCTION' &&
        refs[0][3] === component.id, refs)
      await fixtures.reject(parent, 'parented', '材料或 BOM 结构能力')
      await fixtures.reject(component, 'isMaterial', '材料或 BOM 结构能力')
    })
    await attempt([3], async () => {
      if (!bom) throw new Error('BLOCKED: owned production BOM not created')
      await fixtures.ownership(parent)
      await fixtures.ownership(bom)
      const production = await fixtures.create('production', {
        prodNo: `${fixtures.marker}-PROD`, prodType: '1', remark: fixtures.marker,
        prodOrderSubList: [{ materialId: parent.id, qty: 1, wmsAssembleId: bom.id, remark: fixtures.marker }],
        prodOrderMaterialList: []
      })
      const detail = await fixtures.read(production)
      const subs = data(await api.getBusiness(`/mes/prodOrder/queryMesProdOrderSubByMainId?id=${production.id}`))
      const refs = await fixtures.query('open-production-reference',
        `SELECT id,material_id,status,wms_assemble_id FROM mes_prod_order_sub
         WHERE tenant_id=1 AND deleted=0 AND mid='${production.id}' AND material_id='${parent.id}'
         AND COALESCE(status,0) NOT IN (5,6)`)
      fact(caseRecord, '未完成生产引用按实际保护 Mapper 的 mes_prod_order_sub 口径取证',
        refs.length === 1 && refs[0][1] === parent.id && refs[0][3] === bom.id &&
        asList(subs).some((row) => String(row.materialId) === parent.id),
        { productionId: production.id, status: detail.status, refs, subs })
      await fixtures.reject(parent, 'produced', '可生产能力')
    })
  } catch (error) {
    caseRecord.notes.push(`Fixture prerequisite: ${error.message}`)
    for (let index = 0; index < 5; index++) if (!verified.has(index) && !gaps[index]) gaps[index] = String(error.message)
  } finally {
    try {
      await fixtures.cleanup()
    } finally {
      mapCatalog(caseRecord, verified, gaps)
    }
  }
  return { partial: caseRecord.remainingAssertions.length > 0,
    note: caseRecord.remainingAssertions.map((row) => `${row.index + 1}: ${row.reason}`).join(';') }
}
export async function runHeaded() {
  assertScope()
  const definition = catalogDefinition()
  const record = createRunRecord({ selectedSuites: ['material-capability-fixture'], selectedCases: cases })
  record.evidenceMode = 'isolated-headed-fixture-not-official-runner'
  record.officialRunner = { catalogStatus: definition.status, registered: false,
    note: 'Fixture exports runCase/cases only; shared init/catalog unchanged; no official checkpoint written.' }
  const caseRecord = createCaseRecord({ ...definition, suite: 'material-capability-fixture' })
  record.cases.push(caseRecord)
  const outputDir = ensureDir(path.join(config.outputRoot, record.runId, 'screenshots'))
  const trace = path.join(ensureDir(path.join(config.outputRoot, record.runId, 'trace')), 'PB032-006.zip')
  let handle
  let result
  const started = Date.now()
  try {
    await apiHealth()
    handle = await launchBrowser({ headed: true, record })
    await handle.context.tracing.start({ screenshots: true, snapshots: true, sources: false })
    result = await runCase({ caseId: cases[0], caseRecord, record, page: handle.page, outputDir })
  } catch (error) {
    caseRecord.notes.push(String(error.message))
    if (!caseRecord.checks.some((check) => !check.passed)) {
      addCheck(caseRecord, '夹具执行及清理无未处理异常', false, String(error.message))
    }
    if (handle) await saveScreenshot(handle.page, outputDir, 'PB032-006-error', record).catch(() => {})
  } finally {
    if (handle) {
      await handle.flushResponses().catch((error) => addCheck(caseRecord, '浏览器响应收集', false, error.message))
      for (const [label, errors] of [
        ['console', record.consoleErrors], ['page', record.pageErrors],
        ['business-api', record.failedApiResponses], ['request', record.requestFailures]
      ]) addCheck(caseRecord, `runtime-${label}`, errors.length === 0, JSON.stringify(errors))
      await handle.context.tracing.stop({ path: trace }).catch((error) => addCheck(caseRecord, 'trace', false, error.message))
      try {
        await handle.context.close()
      } finally {
        await handle.browser.close()
      }
      caseRecord.evidence.push(trace)
    }
    const outcome = caseOutcome({ result, failedChecks: caseRecord.checks.filter((row) => !row.passed),
      hasAssertions: caseRecord.checks.length > 0 })
    finishCase(caseRecord, outcome.status, outcome.note)
    caseRecord.durationMs = Date.now() - started
    caseRecord.readyCandidate = outcome.status === 'PASS' && caseRecord.readyCandidate === true
    const report = await writeReport(record)
    console.log(JSON.stringify({ ...report, status: caseRecord.status,
      remainingAssertions: caseRecord.remainingAssertions, cleanup: caseRecord.cleanup, readyCandidate: caseRecord.readyCandidate }))
    process.exitCode = outcome.status === 'PASS' ? 0 : 1
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(' ') !== '--headed') throw new Error('Only --headed is supported; import runCase for runner integration')
  await runHeaded()
}
