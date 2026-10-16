import { randomUUID } from 'node:crypto'

import { config } from '../config/index.mjs'
import { matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'

const text = (value) => String(value ?? '').trim()
const data = (response) => assertBusinessSuccess(response, 'PB032-003 BOM fixture API').data
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
const exactId = (value) => {
  if ((typeof value === 'number' && !Number.isSafeInteger(value)) ||
      !/^[1-9]\d*$/.test(String(value ?? ''))) throw new Error('BLOCKED: PB032-003 ID 必须为精确正整数字符串')
  return String(value)
}
const canonical = (value) => Array.isArray(value)
  ? value.map(canonical)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value
const equal = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
const check = (record, name, passed, details) => {
  record.checks.push({ name, passed: passed === true, details: JSON.stringify(details) })
  if (passed !== true) throw new Error(`PB032-003 ${name}`)
}

export const materialBomCheckNames = Object.freeze({
  serviceParent: 'SERVICE 母件与 STOCK 子件生产 BOM 保存精确拒绝且 API/SQL 不变',
  virtualParent: 'VIRTUAL 母件与 STOCK 子件生产 BOM 保存精确拒绝且 API/SQL 不变',
  serviceChild: 'STOCK 母件与 SERVICE 子件生产 BOM 保存精确拒绝且 API/SQL 不变',
  virtualChild: 'STOCK 母件与 VIRTUAL 子件生产 BOM 保存精确拒绝且 API/SQL 不变',
  cleanup: 'PB032-003 专属物料正式清理且 BOM 主子表无残留'
})

export const materialBomContractGaps = Object.freeze({
  workOrder: '源码契约缺口：MesProdWorkServiceImpl.add 在 super.save 前未调用 MES_WORK_ORDER 场景校验；' +
    '随后以 materialId 查询 BOM，不能用不存在 BOM 的通用拒绝代替非实物门禁证据。未创建工单，保留 GAP。',
  mrp: '源码契约缺口：MrpCoreService.expandBomRecursively/addMaterialDemand 未调用 MRP_DEMAND 场景校验；' +
    '无 BOM 的非自制物料直接进入需求汇总。未构造非法历史 BOM 或工单，保留 GAP。'
})

export function assertMaterialBomScope (settings, enabled) {
  if (enabled !== true || settings.target !== 'local' || String(settings.tenantId) !== '1' ||
      settings.tenantName !== 'CFOR 标准平台' || settings.db?.name !== 'cfor_admin_standard') {
    throw new Error('BLOCKED: PB032-003 仅允许显式启用的本地 CFOR 标准平台 tenant1 专属夹具')
  }
  for (const [base, port] of [[settings.apiBase, '48083'], [settings.webBase, '9151']]) {
    const url = new URL(base)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.port !== port ||
        url.username || url.password) throw new Error('BLOCKED: PB032-003 必须使用本地固定端口')
  }
}

const page = async (api, path) => {
  const result = data(await api.getBusiness(path))
  const rows = result?.records ?? result?.list
  if (!Array.isArray(rows) || !Number.isSafeInteger(result.total) ||
      result.total !== rows.length || rows.length > 100) {
    throw new Error('BLOCKED: PB032-003 专属分页不完整或结构无效')
  }
  return rows
}
const materialPage = (api, code) =>
  page(api, `/mes/basMaterial/list?pageNo=1&pageSize=100&code=${encodeURIComponent(code)}`)
const ownsMaterial = (row, owned) =>
  text(row?.id) === owned.id && text(row?.code) === owned.body.code &&
  text(row?.name) === owned.body.name && text(row?.remark) === owned.body.remark &&
  text(row?.unitId) === owned.body.unitId && row?.inventoryNature === owned.body.inventoryNature &&
  row?.virtualGoods === owned.body.virtualGoods && text(row?.isEnabled) === '1' &&
  row?.produced === owned.body.produced && row?.isMaterial === owned.body.isMaterial &&
  (row?.tenantId == null || text(row.tenantId) === '1')
const readOwnedMaterial = async (api, owned) => {
  const row = data(await api.getBusiness(`/mes/basMaterial/queryById?id=${exactId(owned.id)}`))
  if (!ownsMaterial(row, owned)) throw new Error(`BLOCKED: PB032-003 物料所有权/形态不匹配 ${owned.body.code}`)
  return row
}

const materialBody = (fixture, nature, unitId) => ({
  code: `${fixture.marker}-${nature}`,
  name: `${fixture.marker}-${nature}`,
  auxName: `${fixture.marker}-${nature}`,
  remark: fixture.marker,
  unitId,
  inventoryNature: nature,
  virtualGoods: nature === 'VIRTUAL' ? 'Y' : 'N',
  source: nature === 'STOCK' ? 'mixed' : 'purchase',
  purchased: 'Y',
  saled: 'Y',
  produced: nature === 'STOCK' ? 'Y' : 'N',
  isMaterial: nature === 'STOCK' ? 'Y' : 'N',
  parented: nature === 'STOCK' ? 'Y' : 'N',
  assembled: 'N',
  soned: 'N',
  isEnabled: 1,
  leadTime: 1,
  bufferTime: 1,
  batchManaged: 'N',
  oneBarcode: 'N',
  periodManaged: 'N',
  gradeManaged: 'N',
  colorManaged: 'N',
  brandManaged: 'N',
  backflush: 'N'
})

const createMaterial = async (api, fixture, nature, unitId) => {
  const body = materialBody(fixture, nature, unitId)
  const owned = { kind: 'material', body, id: null, status: 'creating' }
  fixture.materials.push(owned)
  if ((await materialPage(api, body.code)).length !== 0) {
    owned.status = 'not-created'
    throw new Error(`BLOCKED: PB032-003 编码已存在 ${body.code}`)
  }
  try {
    owned.id = exactId(data(await api.postBusiness('/mes/basMaterial/add', body)))
  } catch (error) {
    const rows = (await materialPage(api, body.code)).filter((row) =>
      row.code === body.code && row.remark === fixture.marker)
    if (rows.length > 1) throw new Error('BLOCKED: PB032-003 物料恢复身份不唯一')
    if (rows.length === 1) owned.id = exactId(rows[0].id)
    else owned.status = 'not-created'
    throw error
  }
  await readOwnedMaterial(api, owned)
  owned.status = 'created'
  return owned
}

const scopeSql = (fixture) => {
  if (!/^E2E-PB032003-[A-F0-9]{16}$/.test(fixture.marker)) throw new Error('BLOCKED: PB032-003 marker 非法')
  const ids = fixture.materials.map((owned) => quote(exactId(owned.id))).join(',')
  if (!ids) throw new Error('BLOCKED: PB032-003 缺少本轮物料 ID')
  const main = `(b.mark=${quote(fixture.marker)} OR b.stock_id IN (${ids}))`
  const sub = `(s.mark=${quote(fixture.marker)} OR s.stock_id IN (${ids}) OR s.parent_id IN
    (SELECT b.id FROM mes_wms_assemble b WHERE b.tenant_id=1 AND ${main}))`
  // Include deleted rows and all columns so a rejected write cannot hide a partial insert or update.
  return [
    `SELECT 'bom-main-count',COUNT(*) FROM mes_wms_assemble b WHERE b.tenant_id=1 AND ${main}`,
    `SELECT 'bom-main',b.* FROM mes_wms_assemble b WHERE b.tenant_id=1 AND ${main} ORDER BY b.id`,
    `SELECT 'bom-sub-count',COUNT(*) FROM mes_wms_assemble_sub s WHERE s.tenant_id=1 AND ${sub}`,
    `SELECT 'bom-sub',s.* FROM mes_wms_assemble_sub s WHERE s.tenant_id=1 AND ${sub} ORDER BY s.id`,
    `SELECT 'material',m.* FROM mes_bas_material m WHERE m.tenant_id=1 AND m.id IN (${ids}) ORDER BY m.id`
  ].join(';\n')
}

const readSqlSnapshot = async (readSql, fixture, record, stage) => {
  const result = await readSql(scopeSql(fixture))
  if (!result?.available || !Array.isArray(result.rows)) {
    throw new Error(`BLOCKED: PB032-003 只读 SQL 不可用 ${result?.reason || ''}`)
  }
  record.database = [...(record.database || []), { stage, ...result }]
  const rows = result.rows
  for (const tag of ['bom-main-count', 'bom-sub-count']) {
    const count = rows.filter((row) => row[0] === tag)
    if (count.length !== 1 || count[0].length !== 2 || !/^\d+$/.test(count[0][1])) {
      throw new Error(`BLOCKED: PB032-003 缺少 SQL 计数 ${tag}`)
    }
  }
  if (rows.filter((row) => row[0] === 'material').length !== fixture.materials.length) {
    throw new Error('BLOCKED: PB032-003 SQL 未返回全部本轮物料')
  }
  return structuredClone(rows)
}
const noBomRows = (rows) => ['bom-main-count', 'bom-sub-count'].every((tag) =>
  rows.find((row) => row[0] === tag)?.[1] === '0') &&
  rows.every((row) => !['bom-main', 'bom-sub'].includes(row[0]))

const readApiSnapshot = async (api, fixture) => {
  const materials = []
  const boms = []
  for (const owned of fixture.materials) {
    materials.push(await readOwnedMaterial(api, owned))
    boms.push(await page(api, `/mes/wmsAssemble/list?pageNo=1&pageSize=100&stockId=${exactId(owned.id)}`))
  }
  return structuredClone({ materials, boms })
}
const noApiBom = (snapshot) => snapshot.boms.every((rows) => rows.length === 0) &&
  snapshot.materials.every((row) => text(row.defaultProdBom) === '')

const bomBody = (fixture, parent, child, suffix) => ({
  code: `${fixture.marker}-${suffix}`,
  stockId: exactId(parent.id),
  stockCount: 1,
  version: '1',
  versionDesc: fixture.marker,
  defaultRecord: 'N',
  bomUsage: 'PRODUCTION',
  devStatus: 0,
  unitId: parent.body.unitId,
  mark: fixture.marker,
  wmsAssembleSubList: [{
    stockId: exactId(child.id), subStockCount: 1, unitId: child.body.unitId,
    lossRate: '0', mark: fixture.marker
  }]
})

export const materialBomRejection = (materialName) => ({
  code: 2010100007,
  message: `存货(${materialName})不能用于生产 BOM 用料：服务项目和虚拟件不参与生产与物料需求计划`
})

export async function cleanupMaterialBomValidationFixtures (api, fixture, record, readSql = runReadOnlySql) {
  const failures = []
  const created = fixture.materials.filter((owned) => owned.id)
  if (created.length) {
    const scope = { ...fixture, materials: created }
    const sql = await readSqlSnapshot(readSql, scope, record, 'PB032-003-cleanup-before')
    const apiState = await readApiSnapshot(api, scope)
    // Unexpected committed BOMs require review; never erase the failing business facts.
    if (!noBomRows(sql) || !noApiBom(apiState)) {
      fixture.cleanup = { passed: false, failures: ['拒绝路径出现 BOM/引用，保留本轮注册事实待审查'] }
      check(record, materialBomCheckNames.cleanup, false, {
        marker: fixture.marker, ...fixture.cleanup, sql, apiState
      })
    }
  }
  for (const owned of [...fixture.materials].reverse()) {
    try {
      if (!owned.id) {
        if (owned.status !== 'not-created') throw new Error('创建结果未确认，不能猜测 ID 清理')
        continue
      }
      await readOwnedMaterial(api, owned)
      data(await api.deleteBusiness(`/mes/basMaterial/delete?id=${exactId(owned.id)}`))
      if ((await materialPage(api, owned.body.code)).length !== 0) throw new Error('删除后精确编码仍可见')
      const result = await readSql(`SELECT 'material-active-count',COUNT(*) FROM mes_bas_material
        WHERE tenant_id=1 AND deleted=0 AND id=${quote(owned.id)} AND code=${quote(owned.body.code)}
          AND remark=${quote(fixture.marker)}`)
      record.database = [...(record.database || []), { stage: 'PB032-003-cleanup-material', ...result }]
      if (!result?.available || !equal(result.rows, [['material-active-count', '0']])) {
        throw new Error('删除后 SQL 未确认本轮物料活动记录清零')
      }
      owned.status = 'cleaned'
    } catch (error) {
      failures.push(`${owned.id || owned.body.code}: ${error.message}`)
    }
  }
  fixture.cleanup = { passed: failures.length === 0, failures }
  check(record, materialBomCheckNames.cleanup, failures.length === 0, fixture.cleanup)
}

export async function verifyMaterialBomValidationClosure ({ api, caseRecord, unit }, dependencies = {}) {
  assertMaterialBomScope(dependencies.config || config,
    dependencies.writeFixturesEnabled ?? process.env.CFOR_E2E_WRITE_FIXTURES === 'true')
  const unitId = exactId(unit?.id ?? unit)
  await (dependencies.assertLocalWriteSafety || assertLocalWriteSafety)(caseRecord)
  const readSql = dependencies.runReadOnlySql || runReadOnlySql
  const fixture = {
    kind: 'material-bom-validation',
    marker: `E2E-PB032003-${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`,
    materials: [], attempts: []
  }
  caseRecord.fixtures = [...(caseRecord.fixtures || []), fixture]
  caseRecord.notes.push(materialBomContractGaps.workOrder, materialBomContractGaps.mrp)
  let primaryError
  try {
    const stock = await createMaterial(api, fixture, 'STOCK', unitId)
    const service = await createMaterial(api, fixture, 'SERVICE', unitId)
    const virtual = await createMaterial(api, fixture, 'VIRTUAL', unitId)
    for (const [key, parent, child, invalid] of [
      ['serviceParent', service, stock, service],
      ['virtualParent', virtual, stock, virtual],
      ['serviceChild', stock, service, service],
      ['virtualChild', stock, virtual, virtual]
    ]) {
      const before = {
        api: await readApiSnapshot(api, fixture),
        sql: await readSqlSnapshot(readSql, fixture, caseRecord, `PB032-003-${key}-before`)
      }
      if (!noApiBom(before.api) || !noBomRows(before.sql)) {
        throw new Error('BLOCKED: PB032-003 本轮物料写前已有 BOM 或默认引用')
      }
      const body = bomBody(fixture, parent, child, key.toUpperCase())
      const attempt = { key, body, before, response: null, after: null }
      fixture.attempts.push(attempt)
      const contract = materialBomRejection(invalid.body.name)
      let requestError
      try {
        attempt.response = await api.post('/mes/wmsAssemble/add', body, { expectedBusinessRejection: contract })
      } catch (error) {
        requestError = error
        attempt.requestError = String(error.message)
      }
      attempt.after = {
        api: await readApiSnapshot(api, fixture),
        sql: await readSqlSnapshot(readSql, fixture, caseRecord, `PB032-003-${key}-after`)
      }
      check(caseRecord, materialBomCheckNames[key],
        !requestError && Boolean(attempt.response) && matchesExpectedBusinessRejection(attempt.response, contract) &&
        equal(before, attempt.after) && noBomRows(attempt.after.sql) && noApiBom(attempt.after.api), attempt)
    }
  } catch (error) {
    primaryError = error
  } finally {
    try {
      await cleanupMaterialBomValidationFixtures(api, fixture, caseRecord, readSql)
    } catch (error) {
      primaryError = primaryError
        ? new AggregateError([primaryError, error], `${primaryError.message}; 清理失败: ${error.message}`)
        : error
    }
  }
  if (primaryError) throw primaryError
  caseRecord.evidence.push('PB032-003 四组生产 BOM 父子形态负例均使用本轮真实物料与正式 add API；' +
    '精确领域拒绝后 API/SQL 完整快照不变，无 BOM 主子表/默认引用；MES_WORK_ORDER/MRP_DEMAND 保留源码契约 GAP。')
  return fixture
}

export const __internal = { exactId, materialBody, bomBody, scopeSql, noBomRows }
