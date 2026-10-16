import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { config } from '../config/index.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { decryptResponse, ENCRYPT_HEADER } from '../lib/crypto.mjs'
import { openRoute, saveScreenshot } from '../lib/browser.mjs'

export const MES_SALES_SELECTION_ASSERTION = '销售订单选单人工转生产'
export const MES_SALES_SELECTION_CHECK = '专属两销售单真实选单、取消重开及生产草稿来源 API/SQL 一致'
const scopePrefix = 'E2E-SALES-MSS-'
const definition = {
  material: ['mes_bas_material', 'code', 'remark', '/mes/basMaterial/add', '/mes/basMaterial/queryById'],
  bom: ['mes_wms_assemble', 'code', 'mark', '/mes/wmsAssemble/add', '/mes/wmsAssemble/queryById'],
  route: ['mes_wms_tech_route', 'code', 'mark', '/mes/wmsTechRoute/addMain', '/mes/wmsTechRoute/queryById/dictText'],
  partner: ['base_partner', 'name', 'remark', '/base/partner/create', '/base/partner/get'],
  sale: ['erp_sale_order', 'bill_no', 'remark', '/erp/sale-order/create', '/erp/sale-order/get'],
  production: ['mes_prod_order', 'bill_no', 'remark', null, '/mes/prodOrder/queryById/dictText']
}
const data = (body) => assertBusinessSuccess(body, 'MES sales selection').data
const rows = (body) => {
  const value = data(body)
  const result = Array.isArray(value) ? value : value?.list ?? value?.records
  assert.ok(Array.isArray(result), 'Missing formal rows')
  return result
}
const number = (value) => {
  assert.ok(['string', 'number'].includes(typeof value) && String(value).trim() !== '', 'Missing quantity')
  assert.ok(Number.isFinite(Number(value)) && Number(value) >= 0, 'Invalid quantity')
  return Number(value)
}
const zero = (value, message) => assert.equal(number(value), 0, message)
const receivableHeadColumns = ['id', 'tenant_id', 'bill_no', 'src_bill_type', 'src_bill_id',
  'src_no', 'remark', 'customer_id', 'receivable_type', 'is_auto', 'bill_stage',
  'is_effective', 'is_voided', 'is_closed', 'amt', 'checked_amt', 'after_save_checked_amt',
  'return_amt', 'is_confirm', 'after_save_is_confirm', 'process_instance_id', 'bpmi_instance_id']
const receivableEntryColumns = ['id', 'tenant_id', 'mid', 'bill_no', 'src_bill_type',
  'src_bill_id', 'src_entry_id', 'material_id', 'unit_id', 'qty', 'amt', 'checked_amt',
  'after_save_checked_amt', 'return_amt']

export function assertMesSalesSelectionReceivablesRestored (snapshot, resource) {
  assert.equal(snapshot?.sourceId, mesSalesSelectionId(resource.id), 'Missing exact AR source evidence')
  assert.equal(snapshot.marker, mesSalesSelectionMarker(resource.marker), 'Wrong AR evidence marker')
  assert.equal(snapshot.sql?.available, true, 'Missing AR restoration SQL evidence')
  assert.deepEqual(snapshot.sql.rows, [['ar-counts', '0', '0']],
    'AR recovery unresolved: source headers or entries remain; no automatic finance cascade allowed')
}

const assertReceivableSource = (snapshot, resource) => {
  assert.equal(snapshot?.sourceId, mesSalesSelectionId(resource.id), 'Missing exact AR source evidence')
  assert.equal(snapshot.marker, mesSalesSelectionMarker(resource.marker), 'Wrong AR evidence marker')
  assert.equal(snapshot.sql?.available, true, 'Missing AR SQL evidence')
}

export function assertMesSalesSelectionReceivablesUnconsumed (snapshot, resource) {
  assertReceivableSource(snapshot, resource)
  const heads = snapshot.heads || []
  const entries = snapshot.entries || []
  assert.deepEqual(snapshot.sql.rows.find((row) => row[0] === 'ar-counts'),
    ['ar-counts', String(heads.length), String(entries.length)],
    'AR summary counts must agree with the raw headers and entries')
  if (heads.length === 0 && entries.length === 0) {
    assert.deepEqual(snapshot.sql.rows, [['ar-counts', '0', '0']],
      'AR counts must agree with an empty source snapshot')
    return snapshot
  }
  assert.equal(heads.length, 1, 'Dedicated sale must have at most one automatic AR header')
  assert.ok(entries.length > 0, 'Automatic AR header has no entries')
  const head = heads[0]
  assert.equal(String(head.tenant_id), '1')
  assert.equal(head.src_bill_type, 'SalOrder')
  assert.equal(String(head.src_bill_id), String(resource.id))
  assert.equal(head.src_no, resource.identity)
  assert.equal(head.remark, resource.marker)
  assert.equal(String(head.receivable_type), '101')
  assert.equal(String(head.is_voided), '0')
  assert.equal(String(head.is_effective), '1')
  assert.equal(String(head.bill_stage), '24')
  assert.equal(String(head.is_closed), '0')
  zero(head.checked_amt, 'AR header has checked amount')
  zero(head.after_save_checked_amt, 'AR header has after-save checked amount')
  zero(head.return_amt, 'AR header has return amount')
  for (const entry of entries) {
    assert.equal(String(entry.tenant_id), '1')
    assert.equal(String(entry.mid), String(head.id))
    assert.equal(entry.src_bill_type, 'SalOrder')
    assert.equal(String(entry.src_bill_id), String(resource.id))
    zero(entry.checked_amt, 'AR entry has checked amount')
    zero(entry.after_save_checked_amt, 'AR entry has after-save checked amount')
    zero(entry.return_amt, 'AR entry has return amount')
    assert.notEqual(entry.parent_bill_stage, 'NO_HEADER')
    assert.equal(String(entry.parent_is_effective), '1')
    assert.equal(String(entry.parent_is_voided), '0')
  }
  return snapshot
}

export function assertMesSalesSelectionReceivablesSettled (snapshot, resource) {
  try {
    assertReceivableSource(snapshot, resource)
    const heads = snapshot.heads || []
    const entries = snapshot.entries || []
    assert.deepEqual(snapshot.sql.rows.find((row) => row[0] === 'ar-counts'),
      ['ar-counts', String(heads.length), String(entries.length)],
      'AR summary counts must agree with the raw headers and entries')
    if (heads.length === 0 && entries.length === 0) {
      return assertMesSalesSelectionReceivablesRestored(snapshot, resource)
    }
    assert.equal(heads.length, 1, 'Settled AR must retain one exact audit header')
    assert.ok(entries.length > 0, 'Settled AR must retain its audit entries')
    const head = heads[0]
    assert.equal(String(head.tenant_id), '1')
    assert.equal(head.src_bill_type, 'SalOrder')
    assert.equal(String(head.src_bill_id), String(resource.id))
    assert.equal(head.src_no, resource.identity)
    assert.equal(head.remark, resource.marker)
    assert.equal(String(head.receivable_type), '101')
    assert.equal(String(head.bill_stage), '0')
    assert.equal(String(head.is_effective), '0')
    assert.equal(String(head.is_voided), '1')
    assert.equal(String(head.is_closed), '0')
    zero(head.checked_amt, 'AR audit header has checked amount')
    zero(head.after_save_checked_amt, 'AR audit header has after-save checked amount')
    zero(head.return_amt, 'AR audit header has return amount')
    for (const entry of entries) {
      assert.equal(String(entry.tenant_id), '1')
      assert.equal(String(entry.mid), String(head.id))
      assert.equal(entry.src_bill_type, 'SalOrder')
      assert.equal(String(entry.src_bill_id), String(resource.id))
      zero(entry.checked_amt, 'AR audit entry has checked amount')
      zero(entry.after_save_checked_amt, 'AR audit entry has after-save checked amount')
      zero(entry.return_amt, 'AR audit entry has return amount')
      assert.equal(String(entry.parent_bill_stage), '0')
      assert.equal(String(entry.parent_is_effective), '0')
      assert.equal(String(entry.parent_is_voided), '1')
    }
    return snapshot
  } catch (error) {
    throw new Error(`AR recovery unresolved: ${error.message}`, { cause: error })
  }
}

export function mesSalesSelectionId (value) {
  assert.ok(typeof value === 'string' || Number.isSafeInteger(value), 'Missing or lossy ID')
  assert.match(String(value), /^[1-9]\d*$/, 'Invalid ID')
  return String(value)
}
export function mesSalesSelectionMarker (value = `${scopePrefix}${randomBytes(6).toString('hex').toUpperCase()}`) {
  assert.match(value, /^E2E-SALES-MSS-[A-F0-9]{12}$/, 'Exclusive marker required')
  return value
}
export function assertMesSalesSelectionScope (settings = config, env = process.env) {
  assert.equal(env.CFOR_E2E_WRITE_FIXTURES, 'true', 'BLOCKED: explicit write-fixture opt-in required')
  assert.equal(env.CFOR_E2E_MES_SALES_SELECTION, 'true', 'BLOCKED: explicit sales-selection opt-in required')
  assert.equal(settings.target, 'local', 'BLOCKED: local only')
  assert.equal(String(settings.tenantId), '1', 'BLOCKED: tenant1 only')
  assert.equal(settings.tenantName, 'CFOR 标准平台')
  assert.equal(settings.db?.name, 'cfor_admin_standard')
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(settings.db.host))
  assert.equal(String(settings.db.port), '3306')
  for (const [base, port] of [[settings.webBase, '9151'], [settings.apiBase, '48083']]) {
    const url = new URL(base)
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    assert.equal(url.port, port)
    assert.equal(url.protocol, 'http:')
    assert.ok(['', '/'].includes(url.pathname))
    assert.ok(!url.username && !url.password && !url.search && !url.hash)
  }
}

export function assertMesSalesSelectionSource (source, { marker, customerId, products, counts }) {
  mesSalesSelectionMarker(marker)
  mesSalesSelectionId(source?.id)
  assert.equal(source.remark, marker)
  assert.ok(source.billNo.startsWith(`${marker}-SO-`))
  assert.equal(mesSalesSelectionId(source.customerId), mesSalesSelectionId(customerId))
  assert.equal(Number(source.status), 20, 'GAP: sale order is not formally approved')
  assert.equal(Number(source.isEffective), 1, 'GAP: sale order is not effective')
  assert.ok(Number(source.billStage) >= 24 && Number(source.billStage) <= 34, 'GAP: source is not selectable')
  assert.ok(Array.isArray(source.items) && source.items.length === products.length && products.length === 2)
  const ids = new Set()
  for (let index = 0; index < products.length; index++) {
    const product = products[index]
    const matches = source.items.filter((item) => mesSalesSelectionId(item.productId) === product.id)
    assert.equal(matches.length, 1, 'Missing or duplicate source material')
    const item = matches[0]
    const id = mesSalesSelectionId(item.id)
    assert.ok(!ids.has(id))
    ids.add(id)
    assert.equal(mesSalesSelectionId(item.productUnitId), product.unitId)
    assert.equal(number(item.count), counts[index])
    assert.equal(number(item.prodCount), 0, 'Fresh source has existing production')
    assert.equal(number(item.outCount), 0, 'Fresh source has shipment')
    assert.equal(number(item.returnCount), 0, 'Fresh source has return')
    assert.equal(item.productCode, product.code)
    assert.equal(item.productName, product.code)
  }
  return source
}

export function assertMesSalesSelectionSaved ({ head, entries, sql }, source, marker) {
  mesSalesSelectionMarker(marker)
  const id = mesSalesSelectionId(head?.id)
  assert.equal(head.remark, marker)
  assert.equal(head.billNo, `${marker}-PLAN`)
  assert.equal(String(head.srcBillType), '0')
  assert.equal(mesSalesSelectionId(head.srcBillId), mesSalesSelectionId(source.id))
  assert.equal(mesSalesSelectionId(head.salOrderId), mesSalesSelectionId(source.id))
  assert.equal(mesSalesSelectionId(head.customerId), mesSalesSelectionId(source.customerId))
  assert.equal(String(head.billStage), '14', 'Only a draft/submitted production plan is allowed')
  assert.equal(number(head.isEffective), 0, 'Must not approve or schedule production')
  assert.equal(number(head.qty), source.items.reduce((sum, item) => sum + number(item.count) - number(item.prodCount), 0))
  assert.ok(Array.isArray(entries) && entries.length === source.items.length && entries.length === 2)
  const entryIds = new Set()
  for (const item of source.items) {
    const matches = entries.filter((entry) => String(entry.salOrderEntryId) === mesSalesSelectionId(item.id))
    assert.equal(matches.length, 1, 'Wrong or duplicate sale source entry')
    const entry = matches[0]
    const entryId = mesSalesSelectionId(entry.id)
    assert.ok(!entryIds.has(entryId), 'Duplicate production entry')
    entryIds.add(entryId)
    assert.equal(mesSalesSelectionId(entry.mid), id)
    assert.equal(mesSalesSelectionId(entry.salOrderId), mesSalesSelectionId(source.id))
    assert.equal(mesSalesSelectionId(entry.materialId), mesSalesSelectionId(item.productId))
    assert.equal(mesSalesSelectionId(entry.unitId), mesSalesSelectionId(item.productUnitId))
    assert.equal(number(entry.qty), number(item.count) - number(item.prodCount))
    mesSalesSelectionId(entry.wmsAssembleId)
  }
  assert.ok(sql?.available === true && Array.isArray(sql.rows), 'Missing read-only SQL evidence')
  const heads = sql.rows.filter((row) => row[0] === 'head')
  assert.deepEqual(heads, [['head', id, '1', head.billNo, marker, '0',
    mesSalesSelectionId(source.id), mesSalesSelectionId(source.customerId), '14', '0']])
  const persisted = sql.rows.filter((row) => row[0] === 'entry')
  assert.equal(persisted.length, entries.length)
  for (const entry of entries) {
    const matches = persisted.filter((row) => row[1] === String(entry.id))
    assert.equal(matches.length, 1)
    assert.deepEqual(matches[0].slice(0, 8), ['entry', String(entry.id), id, '1',
      String(entry.salOrderId), String(entry.salOrderEntryId), String(entry.materialId), String(entry.unitId)])
    assert.equal(number(matches[0][8]), number(entry.qty))
    assert.equal(matches[0][9], String(entry.wmsAssembleId))
  }
  return { id, sourceId: String(source.id), entryIds: [...entryIds] }
}

export function isMesSalesSelectionEvidenceVerified (record) {
  try {
    const evidence = record.mesSalesSelectionClosure
    assert.equal(evidence?.assertion, MES_SALES_SELECTION_ASSERTION)
    assert.equal(evidence.status, 'VERIFIED')
    assert.deepEqual(evidence.gaps, [])
    mesSalesSelectionMarker(evidence.marker)
    const { sources, products, customerId, browser, cleanup } = evidence
    assert.equal(sources.length, 2)
    assert.notEqual(mesSalesSelectionId(sources[0].id), mesSalesSelectionId(sources[1].id))
    for (const [index, counts] of [[3, 5], [7, 11]].entries()) {
      assertMesSalesSelectionSource(sources[index], { marker: evidence.marker, products, customerId, counts })
    }
    assert.equal(String(browser.cancelled.id), String(sources[0].id))
    assert.equal(String(browser.selected.id), String(sources[1].id))
    assert.ok(typeof browser.screenshot === 'string' && browser.screenshot.trim())
    assert.deepEqual(browser.writes, [{ method: 'POST', path: '/admin-api/mes/prodOrder/add' }])
    assert.equal(browser.cancellation?.reopenedEmpty, true)
    for (const snapshot of [browser.cancellation.before, browser.cancellation.after]) {
      assert.equal(snapshot?.available, true)
      assert.deepEqual(snapshot.rows, [])
    }
    assert.equal(browser.noExecution?.available, true)
    assert.deepEqual(browser.noExecution.rows,
      [['inventory', '0'], ['stock-lines', '0'], ['works', '0'], ['tasks', '0']])
    const persisted = assertMesSalesSelectionSaved(browser.readback, sources[1], evidence.marker)
    assert.deepEqual(browser.persisted, persisted)
    assert.equal(cleanup.status, 'VERIFIED_WITH_AUDIT_RETENTION')
    const production = cleanup.resources.filter((item) => item.kind === 'production')
    assert.equal(production.length, 1)
    assert.equal(production[0].id, persisted.id)
    assert.equal(production[0].status, 'DELETED_VERIFIED')
    for (const source of sources) {
      const matches = cleanup.resources.filter((item) => item.kind === 'sale' && item.id === String(source.id))
      assert.equal(matches.length, 1)
      const retired = matches[0].status === 'RETREATED_RETAINED_AUDIT'
      assert.ok(retired || matches[0].status === 'VOIDED_RETAINED_AUDIT')
      assert.ok(['PUT', 'READBACK'].includes(matches[0].formalAction?.method))
      assert.equal(matches[0].formalAction.path, '/erp/sale-order/void')
      assert.ok(['VERIFIED', 'VERIFIED_AFTER_RESPONSE_LOSS', 'READBACK_VERIFIED']
        .includes(matches[0].formalAction.status))
      const { final, sql } = matches[0].readback
      assert.equal(mesSalesSelectionId(final.id), String(source.id))
      assert.equal(final.billNo, source.billNo)
      assert.equal(final.remark, evidence.marker)
      assert.equal(String(final.billStage), retired ? '12' : '0')
      assert.equal(number(final.isEffective), 0)
      assert.equal(number(final.isVoided), retired ? 0 : 1)
      assert.equal(sql?.available, true)
      assert.deepEqual(sql.rows, [['sale-cleanup', String(source.id), '1',
        source.billNo, evidence.marker, retired ? '12' : '0', '0', retired ? '0' : '1']])
      assertMesSalesSelectionReceivablesUnconsumed(matches[0].receivablesBefore, {
        id: source.id, identity: source.billNo, marker: evidence.marker
      })
      assertMesSalesSelectionReceivablesSettled(matches[0].receivablesAfter, {
        id: source.id, identity: source.billNo, marker: evidence.marker
      })
    }
    assert.deepEqual(cleanup.unresolved, [])
    assert.ok(cleanup.resources.every((item) => item.marker === evidence.marker &&
      ['DELETED_VERIFIED', 'RETREATED_RETAINED_AUDIT', 'VOIDED_RETAINED_AUDIT', 'RETAINED_AUDIT'].includes(item.status)))
    return true
  } catch { return false }
}

const fact = (record, name, detail) => {
  record.checks ||= []
  record.checks.push({ name, passed: true, details: JSON.stringify(detail) })
}
const gap = (evidence, code, detail) => {
  evidence.gaps.push({ code, detail })
  evidence.status = 'GAP'
}

export class MesSalesSelectionFixture {
  constructor ({ api, caseRecord, marker, readSql = runReadOnlySql,
    settings = config, env = process.env, safetyCheck = assertLocalWriteSafety }) {
    assertMesSalesSelectionScope(settings, env)
    this.api = api
    this.caseRecord = caseRecord
    this.marker = mesSalesSelectionMarker(marker)
    this.readSql = readSql
    this.settings = settings
    this.env = env
    this.safetyCheck = safetyCheck
    this.resources = []
    this.products = []
    this.sales = []
    caseRecord.mesSalesSelectionResources = this.resources
  }
  async ensureWriteSafety () {
    assertMesSalesSelectionScope(this.settings, this.env)
    this.safety ||= this.safetyCheck(this.caseRecord)
    await this.safety
  }
  assertResource (resource) {
    assert.ok(Object.hasOwn(definition, resource?.kind), 'Unknown resource kind')
    assert.equal(resource.marker, this.marker)
    assert.ok(resource.identity?.startsWith(`${this.marker}-`) && /^[A-Z0-9-]+$/.test(resource.identity),
      'Exact exclusive resource identity required')
  }
  async query (stage, statement) {
    const result = await this.readSql(statement)
    assert.ok(result?.available === true && Array.isArray(result.rows), 'GAP: read-only SQL evidence unavailable')
    this.caseRecord.database ||= []
    this.caseRecord.database.push({ stage: `mes-sales-selection:${stage}`, ...result })
    return result
  }
  async recover (resource) {
    this.assertResource(resource)
    const [table, identity, markerColumn] = definition[resource.kind]
    const result = await this.query(`recover-${resource.kind}`,
      `SELECT id FROM ${table} WHERE tenant_id=1 AND deleted=0
       AND ${identity}='${resource.identity}' AND ${markerColumn}='${this.marker}'`)
    assert.ok(result.rows.length <= 1, 'Ambiguous owned resource; no retry or broad cleanup')
    const id = result.rows.length ? mesSalesSelectionId(result.rows[0][0]) : undefined
    if (id && resource.id) assert.equal(id, mesSalesSelectionId(resource.id), 'Resource ID changed; refuse cleanup')
    if (id) resource.id = id
    return id
  }
  async owns (resource) {
    this.assertResource(resource)
    const [table, identity, markerColumn, , endpoint] = definition[resource.kind]
    const id = mesSalesSelectionId(resource.id)
    const current = data(await this.api.getBusiness(`${endpoint}?id=${id}`))
    assert.equal(mesSalesSelectionId(current?.id), id)
    const field = { material: 'code', bom: 'code', route: 'code',
      partner: 'name', sale: 'billNo', production: 'billNo' }[resource.kind]
    assert.equal(current[field], resource.identity)
    assert.equal(current[markerColumn], this.marker)
    const snapshot = await this.query(`own-${resource.kind}`,
      `SELECT id,tenant_id,${identity},${markerColumn} FROM ${table}
       WHERE tenant_id=1 AND deleted=0 AND id='${id}'`)
    assert.deepEqual(snapshot.rows, [[id, '1', resource.identity, this.marker]])
    return current
  }
  async create (kind, body) {
    assert.ok(Object.hasOwn(definition, kind) && kind !== 'production', 'Unsupported creation')
    const [ , , markerColumn, endpoint] = definition[kind]
    const identity = body[{ material: 'code', bom: 'code', route: 'code',
      partner: 'name', sale: 'billNo' }[kind]]
    const resource = { kind, identity, marker: this.marker, status: 'INTENT_RECORDED' }
    this.assertResource(resource)
    assert.equal(body[markerColumn], this.marker)
    await this.ensureWriteSafety()
    assert.equal(await this.recover(resource), undefined, 'Exclusive resource already exists; never retry creation')
    this.resources.push(resource)
    let error
    try {
      data(await this.api.postBusiness(endpoint, body))
    } catch (failure) { error = failure }
    await this.recover(resource)
    if (error) throw error
    assert.ok(resource.id, `Missing persisted ${kind}`)
    resource.status = 'CREATED'
    await this.owns(resource)
    return resource
  }
  async prepare ({ approveSalesOrder } = {}) {
    await this.ensureWriteSafety()
    const template = rows(await this.api.getBusiness('/mes/basMaterial/list/enabled'))
      .find((item) => item.saled === 'Y' && item.unitId)
    assert.ok(template, 'GAP: no enabled sales material with an existing unit; no shared changes')
    const unitId = mesSalesSelectionId(template.unitId)
    const procedureRows = await this.query('existing-procedure', `
      SELECT id,code FROM mes_wms_procedure
      WHERE tenant_id=1 AND deleted=0
      ORDER BY update_time DESC,id DESC LIMIT 1`)
    assert.equal(procedureRows.rows.length, 1,
      'GAP: no reusable procedure exists for the dedicated browser selection route')
    const procedureId = mesSalesSelectionId(procedureRows.rows[0][0])
    const procedureCode = String(procedureRows.rows[0][1])
    const route = await this.create('route', {
      code: `${this.marker}-ROUTE`,
      name: `${this.marker}-ROUTE`,
      version: 'V1.0',
      mark: this.marker,
      type: '1',
      designMode: 'sequential',
      inboundType: 'FINISHED',
      isStrict: 'Y',
      wmsTechRouteSubList: [{
        procedureId,
        procedureName: procedureCode,
        sortOrder: 1,
        isFeed: 0,
        isQuality: 0,
        isFinished: 1,
        isVirtual: 0,
        mark: this.marker
      }]
    })
    this.route = route
    const materials = []
    for (const suffix of ['RM', 'FG1', 'FG2']) {
      const component = suffix === 'RM'
      const resource = await this.create('material', {
        code: `${this.marker}-${suffix}`, name: `${this.marker}-${suffix}`, unitId,
        isEnabled: 1, inventoryNature: 'STOCK', virtualGoods: 'N', source: 'mixed',
        saled: 'Y', purchased: 'Y', produced: 'Y', parented: component ? 'N' : 'Y',
        soned: 'N', assembled: 'N', isMaterial: component ? 'Y' : 'N',
        batchManaged: 'N', oneBarcode: 'N', periodManaged: 'N', gradeManaged: 'N',
        colorManaged: 'N', brandManaged: 'N', backflush: 'N', leadTime: 1, bufferTime: 1,
        refPrice: 10, refCost: 1, remark: this.marker,
        ...(component ? {} : { defaultTechnique: route.id })
      })
      materials.push({ ...resource, code: resource.identity, unitId })
    }
    for (const [index, product] of materials.slice(1).entries()) {
      const bom = await this.create('bom', {
        code: `${this.marker}-BOM${index + 1}`, stockId: product.id, stockCount: 1,
        version: '1', versionDesc: this.marker, defaultRecord: 'Y', bomUsage: 'PRODUCTION',
        unitId, mark: this.marker,
        wmsAssembleSubList: [{ stockId: materials[0].id, subStockCount: 1, unitId, lossRate: 0, mark: this.marker }]
      })
      await this.owns(bom)
      data(await this.api.postBusiness(`/mes/wmsAssemble/publish?id=${bom.id}`))
      const published = await this.owns(bom)
      assert.equal(Number(published.devStatus), 2, 'GAP: dedicated BOM did not publish')
      const material = await this.owns(product)
      assert.equal(String(material.defaultProdBom), bom.id, 'GAP: dedicated default BOM missing')
      this.products.push({ ...product, bomId: bom.id })
    }
    this.partner = await this.create('partner', {
      name: `${this.marker}-CUSTOMER`, shortName: this.marker, partnerKind: 'ORGANIZATION',
      status: 'ACTIVE', customerEnabled: true, supplierEnabled: false, carrierEnabled: false,
      remark: this.marker
    })
    for (const [index, counts] of [[3, 5], [7, 11]].entries()) {
      const time = new Date().toISOString().slice(0, 19)
      const expectedArrivalTime = new Date(Date.parse(`${time}Z`) + 7 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 19)
      const resource = await this.create('sale', {
        billNo: `${this.marker}-SO-${index + 1}`, billDate: time.slice(0, 10), orderTime: time,
        customerId: this.partner.id, saleTypeCode: 'NORMAL', discountPercent: 0, depositPrice: 0,
        remark: this.marker, expectedArrivalTime,
        items: this.products.map((product, item) => ({
          productId: product.id, productUnitId: unitId, count: counts[item],
          productPrice: 10, totalPrice: counts[item] * 10, taxPercent: 0, remark: this.marker,
          expectedArrivalTime
        }))
      })
      let source = await this.owns(resource)
      if (Number(source.status) !== 20 && Number(source.isEffective) !== 1 && String(source.billStage) === '14') {
        data(await this.api.putBusiness(`/erp/sale-order/update-status?id=${resource.id}&status=10`))
        source = await this.owns(resource)
      }
      const processId = source.processInstanceId || source.bpmiInstanceId
      if ((Number(source.status) !== 20 || Number(source.isEffective) !== 1) && processId && approveSalesOrder) {
        // The caller must reuse known credentials/actual task owners; never alter the model or roles.
        const process = data(await this.api.getBusiness(`/bpm/process-instance/get?id=${encodeURIComponent(processId)}`))
        assert.equal(process?.id, processId)
        assert.equal(String(process.businessKey), resource.id)
        assert.equal(String(process.startUser?.id), this.actorId)
        this.caseRecord.fixtures ||= []
        this.caseRecord.fixtures.push({ kind: 'sale-order-bpm', id: processId, owned: true,
          tenantId: '1', tag: this.marker, businessId: resource.id, orderId: resource.id })
        await approveSalesOrder({ resource, source, api: this.api, caseRecord: this.caseRecord })
        source = await this.owns(resource)
      }
      assertMesSalesSelectionSource(source, {
        marker: this.marker, customerId: this.partner.id, products: this.products, counts
      })
      this.sales.push(source)
    }
    fact(this.caseRecord, '两张专属正式销售单各有两条精确物料及不同可生产数量', {
      marker: this.marker, sources: this.sales.map((source) => ({ id: source.id, billNo: source.billNo, items: source.items }))
    })
    return this.sales
  }
  productionIntent () {
    const existing = this.resources.find((item) => item.kind === 'production')
    if (existing) return existing
    const resource = { kind: 'production', identity: `${this.marker}-PLAN`, marker: this.marker, status: 'INTENT_RECORDED' }
    this.resources.push(resource)
    return resource
  }
  async productionSnapshot () {
    return this.query('production-snapshot', `
      SELECT 'head',id,tenant_id,bill_no,remark,src_bill_type,src_bill_id,customer_id,bill_stage,is_effective
      FROM mes_prod_order WHERE tenant_id=1 AND deleted=0 AND bill_no='${this.marker}-PLAN' AND remark='${this.marker}';
      SELECT 'entry',s.id,s.mid,s.tenant_id,s.sal_order_id,s.sal_order_entry_id,s.material_id,s.unit_id,s.qty,s.wms_assemble_id
      FROM mes_prod_order_sub s JOIN mes_prod_order h ON h.id=s.mid AND h.tenant_id=s.tenant_id
      WHERE h.tenant_id=1 AND h.deleted=0 AND s.deleted=0 AND h.bill_no='${this.marker}-PLAN'
        AND h.remark='${this.marker}' ORDER BY s.id`)
  }
  async productionAbsent (resource) {
    this.assertResource(resource)
    const id = mesSalesSelectionId(resource.id)
    const result = await this.query('deleted-production', `
      SELECT 'head',COUNT(*) FROM mes_prod_order WHERE tenant_id=1 AND deleted=0 AND id='${id}';
      SELECT 'entry',COUNT(*) FROM mes_prod_order_sub WHERE tenant_id=1 AND deleted=0 AND mid='${id}';
      SELECT 'material',COUNT(*) FROM mes_prod_order_material WHERE tenant_id=1 AND deleted=0 AND mid='${id}'`)
    assert.deepEqual(result.rows, [['head', '0'], ['entry', '0'], ['material', '0']],
      'Production draft or orphaned lines remain')
  }
  async noExecution () {
    const products = this.resources.filter((item) => item.kind === 'material' && item.id)
      .map((item) => `'${mesSalesSelectionId(item.id)}'`).join(',')
    if (!products) return
    const snapshot = await this.query('no-stock-or-scheduling', `
      SELECT 'inventory',COUNT(*) FROM mes_stk_inventory WHERE tenant_id=1 AND material_id IN (${products});
      SELECT 'stock-lines',COUNT(*) FROM mes_stk_io_entry WHERE tenant_id=1 AND material_id IN (${products});
      SELECT 'works',COUNT(*) FROM mes_prod_work WHERE tenant_id=1 AND material_id IN (${products});
      SELECT 'tasks',COUNT(*) FROM mes_prod_work_task WHERE tenant_id=1 AND product_id IN (${products})`)
    assert.deepEqual(snapshot.rows, [['inventory', '0'], ['stock-lines', '0'], ['works', '0'], ['tasks', '0']],
      'Dedicated selection must not create inventory, WMS documents, work orders or tasks')
    return snapshot
  }
  async saleCleanupReadback (resource) {
    const current = await this.owns(resource)
    const id = mesSalesSelectionId(resource.id)
    const sql = await this.query('sale-cleanup-state',
      `SELECT 'sale-cleanup',id,tenant_id,bill_no,remark,bill_stage,is_effective,is_voided
       FROM erp_sale_order WHERE tenant_id=1 AND deleted=0 AND id='${id}'
         AND bill_no='${resource.identity}' AND remark='${this.marker}'`)
    assert.deepEqual(sql.rows, [['sale-cleanup', id, '1', resource.identity, this.marker,
      String(current.billStage), String(number(current.isEffective)), String(number(current.isVoided))]],
    'Sales cleanup API/SQL state mismatch')
    return { final: current, sql }
  }
  async saleReceivableReadback (resource) {
    this.assertResource(resource)
    const id = mesSalesSelectionId(resource.id)
    const headers = `h.tenant_id=1 AND h.src_bill_id='${id}'`
    const entries = `e.tenant_id=1 AND (e.src_bill_id='${id}' OR
      e.mid IN (SELECT h.id FROM fin_receivable h WHERE ${headers}))`
    // These legacy finance tables have no deleted column. Do not filter away inactive rows or orphan entries.
    const sql = await this.query('sale-cleanup-receivable-state', `
      SELECT 'ar-counts',
        (SELECT COUNT(*) FROM fin_receivable h WHERE ${headers}),
        (SELECT COUNT(*) FROM fin_receivable_entry e WHERE ${entries});
      SELECT 'ar-head',${receivableHeadColumns.map((column) => `h.${column}`).join(',')}
        FROM fin_receivable h WHERE ${headers} ORDER BY h.id;
      SELECT 'ar-entry',${receivableEntryColumns.map((column) => `e.${column}`).join(',')},
        IFNULL(h.bill_stage,'NO_HEADER'),IFNULL(h.is_effective,'NO_HEADER'),IFNULL(h.is_voided,'NO_HEADER')
        FROM fin_receivable_entry e
        LEFT JOIN fin_receivable h ON h.id=e.mid AND h.tenant_id=e.tenant_id
        WHERE ${entries} ORDER BY e.mid,e.id`)
    const decode = (tag, columns) => sql.rows.filter((row) => row[0] === tag).map((row) => {
      assert.equal(row.length, columns.length + 1, 'Incomplete AR state row')
      return Object.fromEntries(columns.map((column, index) => [column, row[index + 1]]))
    })
    return { sourceId: id, marker: this.marker, sql,
      heads: decode('ar-head', receivableHeadColumns),
      entries: decode('ar-entry', [...receivableEntryColumns,
        'parent_bill_stage', 'parent_is_effective', 'parent_is_voided']) }
  }
  async assertSaleCleanupUnconsumed (resource, current, receivablesBefore) {
    for (const field of ['prodCount', 'outCount', 'returnCount', 'afterSaveCount',
      'checkedAmt', 'invoiceMount', 'depositPrice']) {
      assert.equal(number(current[field]), 0, `Do not clean consumed sales source: ${field}`)
    }
    assert.ok(Array.isArray(current.items) && current.items.length > 0, 'Missing sales cleanup lines')
    for (const item of current.items) {
      for (const field of ['prodCount', 'outCount', 'returnCount']) {
        assert.equal(number(item[field]), 0, `Do not clean consumed sales entry: ${field}`)
      }
    }
    const id = mesSalesSelectionId(resource.id)
    // Withdrawal preprocess can cascade into WMS/finance; refuse any downstream document.
    const sql = await this.query('sale-cleanup-dependencies', `
      SELECT 'production-heads',COUNT(*) FROM mes_prod_order
        WHERE tenant_id=1 AND deleted=0 AND src_bill_type='0' AND src_bill_id='${id}';
      SELECT 'production-lines',COUNT(*) FROM mes_prod_order_sub
        WHERE tenant_id=1 AND deleted=0 AND sal_order_id='${id}';
      SELECT 'stock-heads',COUNT(*) FROM mes_stk_io
        WHERE tenant_id=1 AND src_bill_type='SalOrder' AND src_bill_id='${id}';
      SELECT 'receivables',COUNT(*) FROM fin_receivable
        WHERE tenant_id=1 AND src_bill_type='SalOrder' AND src_bill_id='${id}';
      SELECT 'receipts',COUNT(*) FROM fin_receipt
        WHERE tenant_id=1 AND src_bill_type='SalOrder' AND FIND_IN_SET('${id}',src_bill_id)>0;
      SELECT 'receipt-lines',COUNT(*) FROM fin_receipt_entry
        WHERE tenant_id=1 AND src_bill_type='SalOrder' AND src_bill_id='${id}'`)
    const expectedReceivables = String(receivablesBefore?.heads?.length || 0)
    const dependencyRows = new Map(sql.rows.map((row) => [row[0], String(row[1])]))
    for (const kind of ['production-heads', 'production-lines', 'stock-heads', 'receipts', 'receipt-lines']) {
      assert.equal(dependencyRows.get(kind), '0',
        'Sales source has downstream references; no cascading cleanup allowed')
    }
    assert.equal(dependencyRows.get('receivables'), expectedReceivables,
      'Automatic AR count changed during cleanup prechecks')
    await this.noExecution()
    return sql
  }
  async cleanup () {
    await this.ensureWriteSafety()
    const cleanup = { status: 'PENDING', resources: [], unresolved: [] }
    this.caseRecord.mesSalesSelectionCleanup = cleanup
    const failures = []
    let productionUnresolved = false
    // Only the unscheduled production draft is deleted. Source documents and published BOMs retain audit history.
    const ordered = [...this.resources.filter((item) => item.kind === 'production'),
      ...this.resources.filter((item) => item.kind === 'sale').reverse(),
      ...this.resources.filter((item) => !['production', 'sale'].includes(item.kind))]
    for (const resource of ordered) {
      const disposition = { kind: resource.kind, marker: this.marker, identity: resource.identity, id: resource.id }
      cleanup.resources.push(disposition)
      try {
        const present = await this.recover(resource)
        disposition.id = resource.id
        if (!present) {
          if (resource.kind === 'production' && resource.id) await this.productionAbsent(resource)
          disposition.status = 'ABSENCE_VERIFIED'
          continue
        }
        const current = await this.owns(resource)
        if (resource.kind === 'production') {
          assert.equal(String(current.billStage), '14', 'Cleanup refuses non-draft production')
          assert.equal(number(current.isEffective), 0)
          await this.noExecution()
          let writeError
          try { data(await this.api.deleteBusiness(`/mes/prodOrder/delete?id=${resource.id}`)) } catch (error) { writeError = error }
          await this.productionAbsent(resource)
          if (writeError) disposition.recoveredWriteError = writeError.message
          disposition.status = 'DELETED_VERIFIED'
        } else if (resource.kind === 'sale') {
          assert.ok(!productionUnresolved, 'Production cleanup unresolved; retain its sales sources')
          disposition.receivablesBefore = await this.saleReceivableReadback(resource)
          assertMesSalesSelectionReceivablesUnconsumed(disposition.receivablesBefore, resource)
          disposition.preconditions = await this.assertSaleCleanupUnconsumed(
            resource, current, disposition.receivablesBefore)
          disposition.before = await this.saleCleanupReadback(resource)
          assert.deepEqual(disposition.before.final, current, 'Sales source changed during cleanup prechecks')
          const processId = current.processInstanceId || current.bpmiInstanceId
          if (processId) {
            assert.match(processId, /^[a-zA-Z0-9:_-]+$/)
            const process = data(await this.api.getBusiness(`/bpm/process-instance/get?id=${encodeURIComponent(processId)}`))
            assert.equal(process?.id, processId)
            assert.equal(String(process.businessKey), resource.id)
            if (!process.endTime) {
              assert.equal(String(process.startUser?.id), String(this.actorId), 'Cleanup requires the original process starter')
              let cancelError
              try {
                data(await this.api.request('DELETE', '/bpm/process-instance/cancel-by-start-user',
                  { id: processId, reason: `${this.marker} dedicated fixture cleanup` }))
              } catch (error) { cancelError = error }
              const final = data(await this.api.getBusiness(`/bpm/process-instance/get?id=${encodeURIComponent(processId)}`))
              assert.equal(Number(final.status), 4)
              assert.ok(final.endTime)
              const active = rows(await this.api.getBusiness(`/bpm/task/list-by-process-instance-id?processInstanceId=${encodeURIComponent(processId)}`))
                .filter((item) => item.endTime == null && Number(item.status) === 1)
              assert.deepEqual(active, [])
              if (cancelError) disposition.recoveredCancelError = cancelError.message
            }
          }
          let writeError
          const withdrawn = String(current.billStage) === '12' && number(current.isEffective) === 0
          if (number(current.isVoided) !== 1 && !withdrawn) {
            assert.ok(['14', '22', '23', '24', '32', '33', '34'].includes(String(current.billStage)),
              'Unknown sales lifecycle state; refuse cleanup')
            try { data(await this.api.putBusiness('/erp/sale-order/void', { id: resource.id })) } catch (error) { writeError = error }
          }
          disposition.readback = await this.saleCleanupReadback(resource)
          const final = disposition.readback.final
          if (writeError && String(final.billStage) === '12' && number(final.isEffective) === 0) {
            disposition.recoveredWithdrawalError = writeError.message
          }
          disposition.formalAction = {
            method: withdrawn ? 'READBACK' : 'PUT',
            path: '/erp/sale-order/void',
            status: writeError
              ? 'VERIFIED_AFTER_RESPONSE_LOSS'
              : withdrawn ? 'READBACK_VERIFIED' : 'VERIFIED',
            invoked: !withdrawn
          }
          assert.equal(number(final.isEffective), 0)
          disposition.receivablesAfter = await this.saleReceivableReadback(resource)
          assertMesSalesSelectionReceivablesSettled(disposition.receivablesAfter, resource)
          disposition.afterPreconditions = await this.assertSaleCleanupUnconsumed(
            resource, final, disposition.receivablesBefore)
          if (number(final.isVoided) === 1) {
            assert.equal(String(final.billStage), '0', 'Formal source void must be at HAS_BEEN_DEPOSED')
            disposition.status = 'VOIDED_RETAINED_AUDIT'
          } else {
            assert.equal(number(final.isVoided), 0)
            assert.equal(String(final.billStage), '12', 'Formal source withdrawal was not read back at EDITING')
            disposition.status = 'RETREATED_RETAINED_AUDIT'
            disposition.reason = 'Official sales-order void endpoint verified by API/SQL; exact source and AR audit records retained'
          }
        } else {
          disposition.status = 'RETAINED_AUDIT'
          disposition.reason = 'Dedicated source/BOM evidence; no forced deletion or shared changes'
        }
      } catch (error) {
        if (resource.kind === 'production') productionUnresolved = true
        disposition.status = 'RECOVERY_REQUIRED'
        disposition.error = error.message
        failures.push(error)
      }
    }
    cleanup.status = failures.length ? 'RECOVERY_REQUIRED' : 'VERIFIED_WITH_AUDIT_RETENTION'
    if (failures.length) throw new AggregateError(failures, 'Dedicated sales selection cleanup incomplete')
    return cleanup
  }
}

export async function mesSalesSelectionBrowserBody (response) {
  assert.ok(response.ok(), 'Browser HTTP failure is not business evidence')
  const text = await response.text()
  return data(response.headers()[ENCRYPT_HEADER.toLowerCase()] === 'true' ? decryptResponse(text) : JSON.parse(text))
}
const chooser = (page) => page.locator('.el-dialog:visible')
  .filter({ hasText: '生产计划选择销售订单' })
const confirm = (dialog) => dialog.getByRole('button', { name: /^确\s*定$/ })
const bodyRows = (table) => table.locator('.el-table__body-wrapper tbody tr')

export function classifyMesSalesSelectionBrowserRequest (request) {
  const path = new URL(request.url()).pathname
  const method = request.method()
  if (!path.includes('/admin-api/') || ['GET', 'HEAD', 'OPTIONS'].includes(method)) return 'ignore'
  // Only these exact POST handlers have verified read-only service contracts.
  if (method === 'POST' && [
    '/admin-api/mes/prodOrder/prodBom/dictText',
    '/admin-api/system/field-meaning/query-by-condition'
  ].includes(path)) return 'read'
  if (method === 'PUT' &&
      path === '/admin-api/mes/fillRule/executeRuleByCode/mes_scdd_bill_no') return 'numbering'
  return 'write'
}

export async function verifyMesSalesSelectionBrowser ({ page, fixture, outputDir, record, deps }) {
  await fixture.ensureWriteSafety()
  const context = page.context()
  const writeRequests = []
  const formalReadRequests = []
  const numberingRequests = []
  const observe = (request) => {
    const kind = classifyMesSalesSelectionBrowserRequest(request)
    if (kind === 'ignore') return
    const evidence = { method: request.method(), path: new URL(request.url()).pathname }
    if (kind === 'read') formalReadRequests.push(evidence)
    else if (kind === 'numbering') numberingRequests.push(evidence)
    else writeRequests.push(evidence)
  }
  page.on('request', observe)
  const responseFor = (endpoint, query = {}, method = 'GET') => page.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === method && url.pathname === `/admin-api${endpoint}` &&
      Object.entries(query).every(([key, value]) => url.searchParams.get(key) === value)
  })
  const readResponse = async (response) => {
    const url = new URL(response.url())
    assert.ok([new URL(fixture.settings.apiBase).origin, new URL(fixture.settings.webBase).origin].includes(url.origin))
    assert.equal(response.request().headers()['tenant-id'], '1', 'Browser tenant must be explicit')
    return mesSalesSelectionBrowserBody(response)
  }
  const capture = async (endpoint, query, action, method = 'GET') => {
    const pending = responseFor(endpoint, query, method)
    const [response] = await Promise.all([pending, action()])
    return readResponse(response)
  }
  try {
    await deps.openRoute(page, '/mes/produce/order', {
      readySelector: 'input[placeholder="请输入计划单号"]'
    })
    await page.getByRole('button', { name: '新增', exact: true }).click()
    const form = page.locator('.el-dialog:visible')
      .filter({ has: page.getByRole('button', { name: /^选\s*单$/ }) })
    await form.waitFor({ state: 'visible' })
    assert.equal(await form.count(), 1, 'Unique real production form required')
    const expand = form.getByRole('button', { name: '展开基本信息', exact: true })
    if (await expand.count()) await expand.click()
    const fill = async (label, value) => {
      const item = form.locator('.el-form-item').filter({
        has: page.locator('.el-form-item__label').filter({ hasText: new RegExp(`^${label}$`) })
      })
      assert.equal(await item.count(), 1, `Missing real form field ${label}`)
      await item.locator('input, textarea').first().fill(value)
    }
    await fill('生产单号', `${fixture.marker}-PLAN`)
    await fill('备注', fixture.marker)
    const baseline = await fixture.productionSnapshot()
    assert.deepEqual(baseline.rows, [], 'Dedicated plan must not preexist')
    const openChooser = async () => {
      const result = await capture('/erp/sale-order/page', {}, () =>
        form.getByRole('button', { name: /^选\s*单$/ }).click())
      assert.ok(Array.isArray(result?.list), 'Browser formal sales page missing')
      const dialog = chooser(page)
      await dialog.waitFor({ state: 'visible' })
      assert.equal(await dialog.count(), 1)
      assert.ok(await confirm(dialog).isDisabled(), 'Open must not preserve a previous selection')
      assert.equal(await bodyRows(dialog.locator('.el-table').nth(1)).count(), 0)
      return dialog
    }
    const search = async (dialog) => {
      await dialog.getByPlaceholder('请输入销售订单', { exact: true }).fill(fixture.marker)
      const result = await capture('/erp/sale-order/page', { billNo: fixture.marker }, () =>
        dialog.getByRole('button', { name: '搜索', exact: true }).click())
      assert.ok(Array.isArray(result?.list) && result.list.length === 2, 'Only the two dedicated sales sources may appear')
      assert.equal(number(result.total), 2)
      assert.deepEqual(result.list.map((item) => mesSalesSelectionId(item.id)).sort(),
        fixture.sales.map((item) => mesSalesSelectionId(item.id)).sort())
    }
    const choose = async (dialog, source) => {
      const main = bodyRows(dialog.locator('.el-table').first())
        .filter({ hasText: source.billNo })
      await main.waitFor({ state: 'visible' })
      assert.equal(await main.count(), 1, 'Sales bill number must actually render')
      const result = await capture('/erp/sale-order/get', { id: String(source.id) }, () => main.locator('td').first().click())
      assert.equal(mesSalesSelectionId(result?.id), mesSalesSelectionId(source.id))
      await confirm(dialog).waitFor({ state: 'visible' })
      await page.waitForFunction(() => {
        const dialog = [...document.querySelectorAll('.el-dialog')].find((node) =>
          node.getBoundingClientRect().height > 0 && node.textContent.includes('生产计划选择销售订单'))
        return dialog && !dialog.querySelector('.el-dialog__footer .el-button--primary')?.disabled
      })
      const table = dialog.locator('.el-table').nth(1)
      const rendered = bodyRows(table)
      assert.equal(await rendered.count(), 2, 'All source lines must render')
      const headers = await table.locator('.el-table__header-wrapper th').allTextContents()
      for (const item of source.items) {
        const row = rendered.filter({ hasText: item.productCode })
        assert.equal(await row.count(), 1, 'Material code must render exactly once')
        for (const [label, text] of [['存货编码', item.productCode], ['存货名称', item.productName]]) {
          const index = headers.findIndex((header) => header.trim() === label)
          assert.ok(index >= 0, `Missing real material column ${label}`)
          assert.equal((await row.locator('td').nth(index).innerText()).trim(), text)
        }
        for (const [label, quantity] of [['销售订单数', number(item.count)],
          ['生产订单数', number(item.prodCount)], ['可生产数量', number(item.count) - number(item.prodCount)]]) {
          const index = headers.findIndex((text) => text.trim() === label)
          assert.ok(index >= 0, `Missing real quantity column ${label}`)
          assert.equal(number((await row.locator('td').nth(index).innerText()).trim()), quantity)
        }
        assert.equal(await row.locator('input[type="checkbox"]').isChecked(), true)
      }
      return { id: source.id, lines: await rendered.allTextContents() }
    }
    const first = await openChooser()
    await search(first)
    const cancelled = await choose(first, fixture.sales[0])
    await first.getByRole('button', { name: /^取\s*消$/ }).click()
    await first.waitFor({ state: 'hidden' })
    const afterCancel = await fixture.productionSnapshot()
    assert.deepEqual(afterCancel.rows, baseline.rows, 'Cancel must not save any plan')
    assert.deepEqual(writeRequests, [], 'Opening/searching/selecting/cancelling must not issue business writes')
    const reopened = await openChooser()
    await search(reopened)
    await choose(reopened, fixture.sales[0])
    const selected = await choose(reopened, fixture.sales[1])
    const screenshot = await deps.saveScreenshot(page, outputDir, 'mes-sales-selection-owned-two-sources', record)
    assert.ok(screenshot, 'Missing real browser screenshot')
    const materialIds = fixture.products.map((item) => item.id).join(',')
    const versions = await capture('/mes/prodOrder/getVersion', { ids: materialIds },
      () => confirm(reopened).click())
    assert.ok(Array.isArray(versions) && versions.length === 2, 'Missing real BOM versions')
    for (const product of fixture.products) {
      const matches = versions.filter((item) => String(item.materialId) === product.id)
      assert.equal(matches.length, 1)
      assert.ok(matches[0].bomVersions?.some((version) => String(version.value) === product.bomId))
    }
    await reopened.waitFor({ state: 'hidden' })
    assert.deepEqual(writeRequests, [], 'Confirming selection must only populate an unsaved draft')
    // Wait for the existing parent form's formal BOM loading, not an injected Vue state.
    const bom = await capture('/mes/prodOrder/prodBom/dictText', {}, () =>
      form.locator('.vxe-table--main-wrapper .vxe-body--row')
        .filter({ hasText: fixture.products[0].code }).first().click(), 'POST')
    assert.ok(Array.isArray(bom) && bom.length > 0, 'Formal parent BOM detail must be nonempty')
    const component = fixture.resources.find((item) => item.kind === 'material' && item.identity.endsWith('-RM'))
    assert.ok(bom.some((item) => String(item.id) === component.id), 'Dedicated BOM component missing')
    // The production BOM grid renders material code/name through readonly
    // Element Plus inputs, so the value is not part of the row textContent.
    await page.waitForFunction((identity) => {
      const rows = [...document.querySelectorAll(
        '.el-dialog .vxe-table--main-wrapper .vxe-body--row'
      )].filter((row) => {
        const dialog = row.closest('.el-dialog')
        return dialog && dialog.getBoundingClientRect().height > 0
      })
      return rows.some((row) =>
        [...row.querySelectorAll('input')].some((input) => input.value === identity)
      )
    }, component.identity)
    const intent = fixture.productionIntent()
    const saved = await capture('/mes/prodOrder/add', {}, () =>
      form.getByRole('button', { name: /^保\s*存$/ }).click(), 'POST')
    intent.id = mesSalesSelectionId(saved)
    intent.status = 'BROWSER_SAVED'
    const head = await fixture.owns(intent)
    const entries = rows(await fixture.api.getBusiness(`/mes/prodOrder/queryMesProdOrderSubByMainId/dictText?id=${intent.id}`))
    const sql = await fixture.productionSnapshot()
    const persisted = assertMesSalesSelectionSaved({ head, entries, sql }, fixture.sales[1], fixture.marker)
    const noExecution = await fixture.noExecution()
    assert.deepEqual(writeRequests, [{ method: 'POST', path: '/admin-api/mes/prodOrder/add' }],
      'Only the one explicit production draft save may write from this page')
    assert.equal(page.context(), context, 'Must reuse the caller browser context')
    assert.equal(numberingRequests.length, 1, 'Only the existing new-form numbering action is allowed')
    return { cancelled, selected, persisted, readback: { head, entries, sql }, screenshot, writes: writeRequests,
      cancellation: { before: baseline, after: afterCancel, reopenedEmpty: true }, noExecution,
      formalReadRequests, numberingRequests }
  } finally {
    page.off('request', observe)
  }
}

/**
 * Shared-suite integration is deliberately external. Return evidence for assertion #0 only;
 * this fixture never marks MES-PROD-001 (split/scheduling assertions) wholly complete.
 */
export async function runMesSalesSelectionClosure (context, dependencies = {}) {
  const deps = { settings: config, env: process.env, assertLocalWriteSafety, runReadOnlySql,
    openRoute, saveScreenshot, verifyBrowser: verifyMesSalesSelectionBrowser, ...dependencies }
  assertMesSalesSelectionScope(deps.settings, deps.env)
  const { api, page, caseRecord, outputDir, record } = context
  assert.ok(api && page && outputDir && caseRecord, 'BLOCKED: use the existing authenticated API/page/report context')
  const evidence = {
    assertion: MES_SALES_SELECTION_ASSERTION, status: 'GAP', gaps: [], partial: true,
    marker: mesSalesSelectionMarker(deps.marker), originalCasePassCandidate: false
  }
  caseRecord.mesSalesSelectionClosure = evidence
  const fixture = new MesSalesSelectionFixture({ api, caseRecord, marker: evidence.marker,
    readSql: deps.runReadOnlySql, settings: deps.settings, env: deps.env, safetyCheck: deps.assertLocalWriteSafety })
  await fixture.ensureWriteSafety()
  let failure
  try {
    const identity = data(await api.getBusiness('/system/auth/get-permission-info'))
    fixture.actorId = mesSalesSelectionId(identity.user?.id)
    assert.ok(Array.isArray(identity.permissions) &&
      identity.permissions.some((item) => ['*:*:*', 'produce:order:create'].includes(item)),
    'GAP: current actor lacks existing production create permission; no grants')
    await fixture.prepare({ approveSalesOrder: deps.approveSalesOrder })
    evidence.sources = structuredClone(fixture.sales)
    evidence.products = structuredClone(fixture.products)
    evidence.customerId = fixture.partner.id
    await fixture.noExecution()
    evidence.browser = await deps.verifyBrowser({ page, fixture, outputDir, record, deps })
    assert.ok(evidence.browser?.persisted?.id && evidence.browser?.screenshot, 'Missing browser/save evidence')
    evidence.status = 'VERIFIED'
  } catch (error) {
    if (/^(?:GAP:|BLOCKED: 销售审批实际账号无现有本地凭据)/.test(String(error.message))) {
      gap(evidence, 'FORMAL_PREREQUISITE_UNAVAILABLE', error.message)
    }
    else {
      failure = error
      gap(evidence, 'EXECUTION_FAILED', error.message)
    }
  } finally {
    try {
      evidence.cleanup = await fixture.cleanup()
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], failure.message) : error
      gap(evidence, 'CLEANUP_RECOVERY_REQUIRED', error.message)
    }
  }
  if (failure) {
    caseRecord.checks ||= []
    caseRecord.checks.push({ name: MES_SALES_SELECTION_CHECK, passed: false, details: failure.message })
    throw failure
  }
  if (evidence.status === 'VERIFIED') {
    assert.ok(isMesSalesSelectionEvidenceVerified(caseRecord), 'Incomplete sales-selection evidence cannot pass')
    fact(caseRecord, MES_SALES_SELECTION_CHECK, evidence)
  }
  caseRecord.notes ||= []
  caseRecord.notes.push('MES-PROD-001 only sales-selection evidence; no stock/scheduling/role/model changes. Published owned BOMs/master data and sales sources processed through the official void endpoint are retained with exact IDs for audit.')
  return { api, partial: true, salesSelectionVerified: evidence.status === 'VERIFIED', evidence,
    note: evidence.status === 'VERIFIED'
      ? '销售选单原断言已有独立证据；其余拆单/排产断言由主 suite 保留并合并'
      : evidence.gaps.map((item) => item.detail).join('; ') }
}
