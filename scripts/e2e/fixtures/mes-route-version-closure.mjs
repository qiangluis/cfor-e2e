import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { config } from '../config/index.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'
import { assertLocalDatabase, assertLocalWriteSafety, runReadOnlySql } from '../lib/db.mjs'
import { matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { decryptResponse, ENCRYPT_HEADER } from '../lib/crypto.mjs'
import { isExpectedRequestFailure } from '../lib/browser.mjs'
import { ExecutionWorkflowFixture } from './mes-execution-write.mjs'

export const MES_ROUTE_VERSION_ASSERTIONS = Object.freeze([
  '草稿可原地编辑，发布后节点/顺序/资源/质检/委外属性不可原地修改',
  '已发布工艺路线编辑时自动生成新版本草稿',
  '工单任务保存工艺路线版本快照，主档升版不追溯改写历史任务',
  '已发布工艺路线禁止直接删除'
])

export const MES_ROUTE_VERSION_CHECKS = Object.freeze({
  bom: 'MESB006 只读选择合法齐套生产 BOM 并绑定实际启用单位',
  gate: 'MESB006 专属订单正式下达门禁预检全部通过',
  draft: 'MESB006 草稿原地编辑保持主键版本',
  frozen: 'MESB006 发布态主档与节点属性精确拒绝且完整事实不变',
  configurationDraft: 'MESB006 专属草稿工序非空资源设备质检配置正式保存且API与完整SQL一致',
  equipmentFrozen: 'MESB006 发布后设备绑定替换精确拒绝且完整配置事实不变',
  qualityFrozen: 'MESB006 发布后质检配置替换精确拒绝且完整配置事实不变',
  resourceFrozen: 'MESB006 发布后页面工序主资源保存精确拒绝且完整配置事实不变',
  configurationPage: 'MESB006 两版正式页面展示本轮非空主资源与质检配置',
  configurationCleanup: 'MESB006 本轮工序配置所有关联行与停用路线审计保留登记一致',
  upgrade: 'MESB006 发布态编辑生成独立更高版本草稿且旧主子表不变',
  snapshot: 'MESB006 真实发布后排产及升版前后完整任务 API/SQL 快照一致',
  deletion: 'MESB006 已发布路线删除精确拒绝且完整事实不变',
  page: 'MESB006 正式菜单工艺路线页面 DOM/API 成功',
  reverse: 'MESB006 正式停用保留路线和旧任务快照',
  cleanupSnapshot: 'MESB006 本轮订单工单任务只读零残留与 registry 保留项精确对账',
  cleanup: 'MESB006 专属 registry 清理与保留项全部回读'
})

export const MES_ROUTE_RESOURCE_GAP =
  '发布态资源/质检配置须由非空草稿保存、设备绑定/质检替换/工序详情三入口精确拒绝、完整API/SQL不变、两版真实页面及配置清理登记共同证明；工序级共享配置与路线版本冻结的边界尚未确认时不得判PASS'

export const MES_ROUTE_CONFIGURATION_REJECTION = Object.freeze({
  code: 400, message: '工艺路线已发布，节点、顺序、资源、质检和委外属性不可原地修改，请新建版本'
})

const configurationTables = Object.freeze([
  'mes_procedure_equipment_relation', 'mes_procedure_quality_item',
  'mes_wms_procedure_main_resource', 'mes_wms_procedure_aux_resource',
  'mes_wms_procedure_material_usage', 'mes_wms_procedure_auto_split',
  'mes_wms_procedure_switch_config'
])

const configurationPaths = new Set([
  '/mes/wmsTechRoute/batchCreateProcedureQuality',
  '/mes/wmsTechRoute/saveprocedureEquipmentRelation',
  '/mes/wmsProcedure/editDetail'
])

export const MES_ROUTE_VERSION_OPTIONS = Object.freeze({
  withOpeningInventory: false, reuseEnabledBom: true, schedule: false,
  withTeam: true, withFeed: false, withQuality: false
})

const taskFields = Object.freeze({
  id: 'id', workTicketId: 'work_ticket_id', productId: 'product_id',
  routing: 'routing', processId: 'process_id', routeNodeId: 'route_node_id',
  routeVersion: 'route_version', status: 'status', isDeleted: 'is_deleted',
  isEffective: 'is_effective', taskNum: 'task_num', workTicketTotal: 'work_ticket_total',
  remark: 'remark', teamId: 'team_id', memberIds: 'member_ids',
  leaderId: 'leader_id', prodLineId: 'prod_line_id'
})
// Persisted MesProdWorkTask + SourceDO fields; null is evidence, omission is not.
export const MES_ROUTE_TASK_API_FIELDS = Object.freeze([
  ...Object.keys(taskFields), 'sysOrgCode', 'workOrderTaskCode', 'stepInstanceId',
  'capacityId', 'capacityVersion', 'processName', 'reportVersion', 'prodWorkshopId',
  'qcDepartId', 'qcInspector', 'version', 'reportTotalNum', 'reportTime',
  'reportUserId', 'reportTeamId', 'qualifiedNum', 'unqualifiedNum', 'unqualifiedReason',
  'isPieceCounted', 'urgentLevel', 'planStartTime', 'planEndTime', 'sortOrder',
  'allowStepOutsource', 'scheduleStatus', 'equipmentId', 'barCodeId', 'outsourceFlag',
  'outsourceType', 'outsourceSupplierId', 'outsourceProcessPrice', 'outsourceStatus',
  'outsourceOrderId', 'processInstanceId', 'canReportNum', 'isQuality', 'isFeed',
  'feedPickStatus', 'isRework', 'reworkSeq', 'createTime', 'createBy', 'updateTime', 'updateBy',
  ...Array.from({ length: 20 }, (_, index) => `customField${index + 1}`)
])
const sqlColumn = (field) => field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
const tables = new Set([
  'mes_wms_tech_route', 'mes_wms_tech_route_sub', 'mes_prod_work_task',
  'mes_wms_procedure', 'mes_team_manage', ...configurationTables
])
const id = (value) => {
  assert.ok(typeof value === 'string' || Number.isSafeInteger(value), 'Unsafe resource ID')
  assert.match(String(value), /^[1-9]\d*$/, 'Missing resource ID')
  return String(value)
}
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}
export const mesRouteFactHash = (value) =>
  createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')

class EvidenceGap extends Error {}
const requireField = (value, key, context) => {
  if (!Object.hasOwn(value || {}, key) || value[key] === undefined) {
    throw new EvidenceGap(`${context}_FIELD_UNAVAILABLE: ${key}`)
  }
}
const dataOf = (response) => {
  assert.ok(isBusinessSuccess(response), 'MESB006 official API business failure')
  return response.data
}
const rowsOf = (response) => {
  const data = dataOf(response)
  const rows = Array.isArray(data) ? data : data?.records ?? data?.list
  assert.ok(Array.isArray(rows) && rows.length <= 100, 'Invalid official page contract')
  if (!Array.isArray(data) && Number(data.total) !== rows.length) {
    assert.fail('Official page readback is incomplete')
  }
  return rows
}
const addCheck = (record, name, details) => {
  record.checks.push({ name, passed: true, details })
}

export function assertMesRouteVersionTarget (record, settings = config,
  writeFlag = process.env.CFOR_E2E_WRITE_FIXTURES, tenantId) {
  assert.equal(settings.target, 'local', 'BLOCKED: MESB006 only allows local')
  assert.equal(String(settings.tenantId), '1', 'BLOCKED: MESB006 only allows tenant1')
  assert.equal(String(record.environment?.tenantId), '1', 'BLOCKED: MESB006 login tenant mismatch')
  assert.equal(String(tenantId), '1', 'BLOCKED: MESB006 requires formal login tenant1')
  assert.equal(writeFlag, 'true', 'BLOCKED: MESB006 requires fixture write flag')
  for (const [base, port] of [[settings.apiBase, '48083'], [settings.webBase, '9151']]) {
    const url = new URL(base)
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'BLOCKED: loopback required')
    assert.equal(url.port, port, 'BLOCKED: MESB006 local port mismatch')
  }
  assertLocalDatabase(settings.db)
}

export function mesRouteVersionScopedApi (api, { beforeTransfer, allowConfigurationWrite } = {}) {
  return new Proxy(api, {
    get (target, key) {
      const value = target[key]
      if (typeof value !== 'function') return value
      return (...args) => {
        const pathname = key === 'request' ? args[1] : args[0]
        const method = key === 'request' ? args[0] : String(key).replace(/Business$/, '').toUpperCase()
        const path = new URL(pathname, 'http://local.test').pathname
        assert.ok(!/\/(?:stkIo|stkInventory|prodWorkReport)(?:\/|$)|\/(?:start|reportWork|feed[^/]*|worker|retry)(?:\/|$)/i.test(path),
          'MESB006 forbids inventory/feed/start/report/worker operations')
        if (configurationPaths.has(path) && method !== 'GET') {
          assert.ok(typeof allowConfigurationWrite === 'function',
            'MESB006 cannot mutate resource/quality configuration without owned procedure scope')
          const body = key === 'request' ? args[2] : args[1]
          allowConfigurationWrite(method, path, body)
        }
        if (method !== 'GET') {
          assert.ok(!/^\/system\/(?:role|user|permission|tenant|tenant-package)(?:\/|$)/.test(path),
            'MESB006 cannot change authorization')
          assert.ok(!/^\/mes\/(?:basMaterial|wmsAssemble)(?:\/|$)/.test(path),
            'MESB006 only reads existing material/BOM facts')
        }
        if (path === '/mes/prodWork/transferWorkOrder' && method !== 'GET' && beforeTransfer) {
          assert.equal(method, 'POST', 'MESB006 transfer must use its official POST contract')
          const body = key === 'request' ? args[2] : args[1]
          return Promise.resolve().then(() => beforeTransfer(body)).then(() => value.apply(target, args))
        }
        return value.apply(target, args)
      }
    }
  })
}

export function assertMesRouteConfigurationWrite (fixture, method, path, body) {
  assert.equal(method, 'POST', 'MESB006 configuration only permits official POST')
  assert.ok(configurationPaths.has(path), 'MESB006 unknown configuration endpoint')
  const procedureId = id(fixture.procedure?.id)
  assert.ok(fixture.owned.some((row) => row.kind === 'procedure' && row.id === procedureId &&
    row.marker === fixture.marker && row.identity === fixture.procedure.identity),
  'MESB006 configuration requires current owned procedure registry')
  if (path === '/mes/wmsProcedure/editDetail') {
    assert.equal(id(body?.id), procedureId, 'MESB006 configuration procedure ownership mismatch')
    assert.equal(body.mark, fixture.marker, 'MESB006 configuration marker mismatch')
  } else {
    assert.ok(Array.isArray(body) && body.length === 1, 'MESB006 configuration requires exactly one owned row')
    assert.equal(id(body[0].procedureId), procedureId, 'MESB006 configuration procedure ownership mismatch')
    assert.equal(body[0].remark, fixture.marker, 'MESB006 configuration marker mismatch')
  }
}

async function readMesRouteConfigurationScope (fixture, readSql) {
  const procedureId = id(fixture.procedure.id)
  const rows = await readRows(readSql, `
    SELECT CAST(n.id AS CHAR), CAST(n.parent_id AS CHAR), r.code, r.mark,
           r.version, CAST(r.dev_status AS CHAR)
    FROM mes_wms_tech_route_sub n
    LEFT JOIN mes_wms_tech_route r
      ON r.id=n.parent_id AND r.tenant_id=n.tenant_id AND r.deleted=0
    WHERE n.tenant_id=1 AND n.deleted=0 AND n.procedure_id=${quote(procedureId)}
    ORDER BY n.parent_id, n.id`)
  assert.ok(rows.length, 'MESB006 configuration requires an actual owned route reference')
  const references = rows.map(([nodeId, routeId, code, mark, version, devStatus]) => {
    const resource = fixture.owned.find((row) => row.kind === 'route' && row.id === id(routeId))
    assert.ok(resource && resource.marker === fixture.marker &&
      resource.identity === code && mark === fixture.marker,
    'MESB006 configuration cannot mutate a procedure referenced by a foreign or unregistered route')
    assert.ok(typeof version === 'string' && version.trim(), 'Missing referenced route version')
    assert.ok(['0', '2', '3'].includes(String(devStatus)), 'Unknown referenced route publication state')
    return { nodeId: id(nodeId), routeId: id(routeId), version, devStatus: Number(devStatus) }
  })
  assert.equal(new Set(references.map((row) => row.nodeId)).size, references.length,
    'Duplicate configuration route reference')
  return { procedureId, marker: fixture.marker, scope: 'CURRENT_RUN_ONLY', references }
}

export async function readMesRouteConfiguration (fixture, readSql) {
  const procedureId = id(fixture.procedure.id)
  const detail = dataOf(await fixture.api.getBusiness(`/mes/wmsProcedure/queryDetailById?id=${procedureId}`))
  assert.equal(id(detail?.id), procedureId, 'Configuration detail ownership mismatch')
  assert.equal(detail.mark, fixture.marker, 'Configuration detail marker mismatch')
  assert.equal(detail.code, fixture.procedure.identity, 'Configuration detail code mismatch')
  assert.ok(typeof detail.name === 'string' && detail.name.trim(), 'Missing configuration procedure name')
  const equipment = rowsOf(await fixture.api.getBusiness(
    `/mes/procedure-equipment-relation/page?procedureId=${procedureId}&pageNo=1&pageSize=100`))
  const quality = rowsOf(await fixture.api.getBusiness(
    `/mes/procedure-quality-item/page?procedureId=${procedureId}&pageNo=1&pageSize=100`))
  for (const row of [...equipment, ...quality]) {
    assert.equal(id(row.procedureId), procedureId, 'Foreign procedure configuration returned')
    assert.equal(row.remark, fixture.marker, 'Foreign procedure configuration marker returned')
  }
  const sql = {}
  for (const table of configurationTables) {
    sql[table] = await readMesRouteFullRows(readSql, table,
      `procedure_id=${quote(procedureId)}`)
  }
  sql.mes_wms_procedure = await readMesRouteFullRows(readSql, 'mes_wms_procedure',
    `id=${quote(procedureId)} AND deleted=0`)
  assert.equal(sql.mes_wms_procedure.length, 1, 'Missing owned procedure SQL row')
  for (const [rows, table] of [[equipment, configurationTables[0]], [quality, configurationTables[1]],
    [detail.mainResources, configurationTables[2]]]) {
    assert.ok(Array.isArray(rows), 'Missing configuration API collection')
    assert.deepEqual(rows.map((row) => id(row.id)).sort(),
      sql[table].filter((row) => row.deleted === '0').map((row) => id(row.id)).sort(),
      `Configuration API/SQL IDs mismatch: ${table}`)
  }
  return { api: { detail, equipment, quality }, sql }
}

const configurationProof = (snapshot) => ({
  apiHash: mesRouteFactHash(snapshot.api), sqlHash: mesRouteFactHash(snapshot.sql),
  tables: Object.fromEntries(Object.entries(snapshot.sql).map(([table, rows]) =>
    [table, { ids: rows.map((row) => id(row.id)),
      liveIds: rows.filter((row) => row.deleted === '0').map((row) => id(row.id)),
      fields: rows.length ? Object.keys(rows[0]).sort() : [] }]))
})

const decimal = (value) => {
  assert.match(String(value), /^\d+(?:\.\d+)?$/, 'Invalid configuration numeric value')
  const [integer, fraction = ''] = String(value).split('.')
  return `${integer.replace(/^0+(?=\d)/, '')}.${fraction.replace(/0+$/, '')}`
}

export async function prepareMesRouteConfiguration (fixture, readSql, caseRecord) {
  const procedureId = id(fixture.procedure.id)
  const qualityRows = await readRows(readSql, `
    SELECT CAST(p.id AS CHAR), CAST(i.id AS CHAR), p.plan_name, i.item_name
    FROM mes_quality_plan p
    JOIN mes_quality_plan_sub s ON s.mid=p.id AND s.tenant_id=p.tenant_id AND s.deleted=0
    JOIN mes_quality_item i ON i.id=s.item_id AND i.tenant_id=p.tenant_id AND i.deleted=0
    WHERE p.tenant_id=1 AND p.deleted=0 AND p.publish_status=1
      AND p.type=300 AND i.publish_status=1 ORDER BY p.id DESC, s.id LIMIT 1`)
  const deviceRows = await readRows(readSql, `
    SELECT CAST(id AS CHAR), device_name FROM iot_device
    WHERE tenant_id=1 AND deleted=0 AND asset_status='ENABLED' ORDER BY id LIMIT 1`)
  const resourceRows = await readRows(readSql, `
    SELECT CAST(id AS CHAR), resource_code, resource_name FROM aps_main_resource
    WHERE tenant_id=1 AND status=1 ORDER BY id LIMIT 1`)
  if (!qualityRows.length || !deviceRows.length || !resourceRows.length) {
    throw new EvidenceGap('CONFIGURATION_REFERENCE_UNAVAILABLE: published quality/item, enabled device and main resource required')
  }
  const [planId, itemId, planName, itemName] = qualityRows[0]
  const [equipmentId, equipmentName] = deviceRows[0]
  const [resourceId, resourceCode, resourceName] = resourceRows[0]
  for (const value of [planId, itemId, equipmentId, resourceId, fixture.lineId]) id(value)
  const plan = dataOf(await fixture.api.getBusiness(`/mes/quality/qualityPlan/queryById/dictText?id=${planId}`))
  assert.equal(id(plan?.id), planId, 'Quality reference API/SQL mismatch')
  assert.equal(Number(plan.publishStatus), 1, 'Quality reference must be published')
  const resourceMatches = rowsOf(await fixture.api.getBusiness(
    `/mes/main-resource/page?id=${resourceId}&pageNo=1&pageSize=100`))
  assert.equal(resourceMatches.length, 1, 'Main resource reference must be uniquely visible')
  const resource = resourceMatches[0]
  assert.equal(id(resource?.id), resourceId, 'Main resource reference API/SQL mismatch')
  assert.equal(resource.resourceCode, resourceCode, 'Main resource reference code mismatch')
  const configuration = {
    references: { readOnly: true, planId, itemId, planName, itemName,
      equipmentId, equipmentName, resourceId, resourceCode, resourceName },
    equipment: { procedureId, productionLineId: id(fixture.lineId), equipmentId,
      sortOrder: 1, bindType: 'primary', status: '1', standardCapacityPerHour: 10,
      standardEnergyPerHour: 1, remark: fixture.marker },
    quality: { procedureId, qualityPlanId: planId, qualityItemId: itemId, isRequired: 'Y',
      frequency: '每批', target: '100%', sortOrder: 1, status: '1', remark: fixture.marker },
    detail: { id: procedureId, mark: fixture.marker, mainResources: [{
      resourceId, code: resourceCode, name: resourceName, priority: 1, capacity: 1
    }] }
  }
  // Register the procedure scope before writes, including responses lost after persistence.
  fixture.routeConfiguration = configuration
  caseRecord.mesRouteVersionEvidence.configuration = { references: configuration.references, probes: [] }
  const empty = await readMesRouteConfiguration(fixture, readSql)
  assert.ok(Object.entries(empty.sql).filter(([table]) => table !== 'mes_wms_procedure')
    .every(([, rows]) => rows.length === 0), 'New owned procedure already has configuration rows')
  caseRecord.mesRouteVersionEvidence.configuration.draftScope =
    await readMesRouteConfigurationScope(fixture, readSql)
  dataOf(await fixture.api.postBusiness('/mes/wmsTechRoute/saveprocedureEquipmentRelation', [configuration.equipment]))
  dataOf(await fixture.api.postBusiness('/mes/wmsTechRoute/batchCreateProcedureQuality', [configuration.quality]))
  dataOf(await fixture.api.postBusiness('/mes/wmsProcedure/editDetail', configuration.detail))
  const baseline = await readMesRouteConfiguration(fixture, readSql)
  for (const [apiRows, table, expected] of [
    [baseline.api.equipment, configurationTables[0], configuration.equipment],
    [baseline.api.quality, configurationTables[1], configuration.quality],
    [baseline.api.detail.mainResources, configurationTables[2], configuration.detail.mainResources[0]]
  ]) {
    assert.equal(apiRows.length, 1, 'Draft configuration must be nonempty and unique')
    const sqlRows = baseline.sql[table].filter((row) => row.deleted === '0')
    assert.equal(sqlRows.length, 1, 'Draft SQL configuration must be nonempty and unique')
    const sqlRow = sqlRows[0]
    for (const [field, value] of Object.entries(expected)) {
      const column = sqlColumn(field)
      requireField(apiRows[0], field, 'CONFIGURATION')
      requireField(sqlRow, column, 'SQL_CONFIGURATION')
      const normalize = typeof value === 'number' ? decimal : String
      assert.equal(normalize(apiRows[0][field]), normalize(value), `Draft API configuration mismatch: ${field}`)
      assert.equal(normalize(sqlRow[column]), normalize(apiRows[0][field]),
        `Draft SQL configuration mismatch: ${field}`)
    }
  }
  configuration.baseline = baseline
  configuration.latest = baseline
  caseRecord.mesRouteVersionEvidence.configuration.draft = configurationProof(baseline)
  addCheck(caseRecord, MES_ROUTE_VERSION_CHECKS.configurationDraft,
    `procedure=${procedureId}; equipment=1; quality=1; mainResource=1; referencesReadOnly=true`)
  return configuration
}

export async function verifyMesRouteConfigurationFrozen (fixture, readSql, caseRecord) {
  const configuration = fixture.routeConfiguration
  if (!configuration?.baseline) throw new EvidenceGap('CONFIGURATION_DRAFT_EVIDENCE_UNAVAILABLE')
  const names = MES_ROUTE_VERSION_CHECKS
  const evidence = caseRecord.mesRouteVersionEvidence.configuration
  for (const [name, path, body] of [
    [names.equipmentFrozen, '/mes/wmsTechRoute/saveprocedureEquipmentRelation',
      [{ ...configuration.equipment, standardCapacityPerHour: 11 }]],
    [names.qualityFrozen, '/mes/wmsTechRoute/batchCreateProcedureQuality',
      [{ ...configuration.quality, target: '99%' }]],
    [names.resourceFrozen, '/mes/wmsProcedure/editDetail',
      { ...configuration.detail, mainResources: configuration.detail.mainResources.map((row) => ({ ...row, capacity: 2 })) }]
  ]) {
    const before = await readMesRouteConfiguration(fixture, readSql)
    const scope = await readMesRouteConfigurationScope(fixture, readSql)
    assert.ok(scope.references.every((row) => row.devStatus === 2),
      'MESB006 configuration freeze probes require genuinely published owned routes')
    const response = await fixture.api.request('POST', path, body,
      { expectedBusinessRejection: MES_ROUTE_CONFIGURATION_REJECTION })
    const after = await readMesRouteConfiguration(fixture, readSql)
    configuration.latest = after
    const rejected = matchesExpectedBusinessRejection(response, MES_ROUTE_CONFIGURATION_REJECTION)
    const beforeProof = configurationProof(before)
    const afterProof = configurationProof(after)
    const apiUnchanged = beforeProof.apiHash === afterProof.apiHash
    const sqlUnchanged = beforeProof.sqlHash === afterProof.sqlHash
    const unchanged = apiUnchanged && sqlUnchanged
    // Procedure-scoped writes cannot establish a route-scoped freeze policy.
    // Keep every failed freeze assertion; classification is diagnostic evidence only.
    const classification = rejected
      ? (unchanged ? 'FROZEN_VERIFIED' : 'REJECTED_BUT_FACTS_CHANGED')
      : isBusinessSuccess(response)
        ? (unchanged ? 'ACCEPTED_WITHOUT_FREEZE_REJECTION' : 'SHARED_PROCEDURE_FREEZE_DECISION_REQUIRED')
        : (unchanged ? 'UNEXPECTED_BUSINESS_REJECTION' : 'FAILED_RESPONSE_WITH_FACT_CHANGES')
    const probe = { path, code: response?.code, message: response?.msg ?? response?.message,
      classification, scope,
      rejected, apiUnchanged, sqlUnchanged, before: beforeProof, after: afterProof,
      actual: {
        equipmentCapacity: after.api.equipment.map((row) => row.standardCapacityPerHour),
        qualityTargets: after.api.quality.map((row) => row.target),
        resourceCapacity: after.api.detail.mainResources.map((row) => row.capacity)
      } }
    evidence.probes.push(probe)
    caseRecord.checks.push({ name, passed: rejected && apiUnchanged && sqlUnchanged,
      details: JSON.stringify({ path, code: probe.code, classification, rejected, apiUnchanged, sqlUnchanged }) })
  }
  const classifications = [...new Set(evidence.probes.map((probe) => probe.classification))]
  evidence.diagnosis = { classifications,
    policyDecisionRequired: classifications.includes('SHARED_PROCEDURE_FREEZE_DECISION_REQUIRED'),
    acceptanceUnchanged: true }
  if (evidence.diagnosis.policyDecisionRequired) {
    caseRecord.notes.push('MESB006 DECISION_REQUIRED: 已发布路线共用本轮专属工序；procedureId 维度配置写入成功且 API/SQL 改变，非超时。须确认共享工序冻结或路线版本配置快照边界；三个冻结断言保持真实结果，不自动改判通过。')
  }
}

export async function prepareMesRouteConfigurationCleanup (fixture, readSql, published) {
  if (!fixture.routeConfiguration) return
  const current = await readMesRouteConfiguration(fixture, readSql)
  fixture.routeConfiguration.beforeCleanup = current
  if (published.size) return
  // Procedure deletion cascades its five detail tables, but not these two bindings.
  for (const [rows, endpoint] of [
    [current.api.equipment, '/mes/procedure-equipment-relation/delete'],
    [current.api.quality, '/mes/procedure-quality-item/delete']
  ]) {
    for (const row of rows) {
      assert.equal(id(row.procedureId), id(fixture.procedure.id), 'Configuration cleanup ownership mismatch')
      assert.equal(row.remark, fixture.marker, 'Configuration cleanup marker mismatch')
      dataOf(await fixture.api.deleteBusiness(`${endpoint}?id=${id(row.id)}`))
    }
  }
}

export async function auditMesRouteConfigurationCleanup (fixture, readSql, caseRecord, published) {
  if (!fixture.routeConfiguration) return
  const before = fixture.routeConfiguration.beforeCleanup
  assert.ok(before, 'Missing configuration cleanup baseline')
  const sql = {}
  for (const table of configurationTables) {
    sql[table] = await readMesRouteFullRows(readSql, table,
      `procedure_id=${quote(id(fixture.procedure.id))}`)
  }
  sql.mes_wms_procedure = await readMesRouteFullRows(readSql, 'mes_wms_procedure',
    `id=${quote(id(fixture.procedure.id))}`)
  for (const [table, rows] of Object.entries(sql)) {
    for (const row of rows) {
      assert.equal(id(row[table === 'mes_wms_procedure' ? 'id' : 'procedure_id']),
        id(fixture.procedure.id), 'Configuration cleanup foreign procedure')
    }
  }
  const retained = published.size > 0
  if (retained) {
    assert.equal(mesRouteFactHash(sql), mesRouteFactHash(before.sql), 'Retained configuration SQL drifted during cleanup')
    const principal = fixture.owned.find((row) => row.kind === 'procedure' && row.id === fixture.procedure.id)
    assert.equal(principal?.cleanup, 'RETAINED_AUDIT_ROUTE_REFERENCE', 'Configuration principal retention unverified')
    for (const routeId of published) {
      assert.ok(caseRecord.mesRouteVersionEvidence.retained.some((row) =>
        row.kind === 'route' && row.id === routeId && row.cleanup === 'RETAINED_AUDIT_DISABLED'),
      'Configuration referenced route retention unverified')
    }
  } else {
    assert.ok(Object.values(sql).flat().every((row) => row.deleted === '1'), 'Unpublished configuration has live residue')
  }
  const proof = configurationProof({ api: before.api, sql })
  const evidence = { procedureId: id(fixture.procedure.id), marker: fixture.marker,
    cleanup: retained ? 'RETAINED_AUDIT_ROUTE_REFERENCE' : 'DELETED_VERIFIED',
    referencedRoutes: [...published], ...proof }
  caseRecord.mesRouteVersionEvidence.configuration.cleanup = evidence
  if (retained) caseRecord.mesRouteVersionEvidence.retained.push({ kind: 'procedureConfiguration', ...evidence })
  addCheck(caseRecord, MES_ROUTE_VERSION_CHECKS.configurationCleanup, JSON.stringify(evidence))
}

async function readRows (readSql, sql) {
  assert.match(sql.trim(), /^SELECT\b/i, 'Only SELECT evidence is allowed')
  const result = await readSql(sql)
  if (!result?.available) throw new EvidenceGap('READ_ONLY_SQL_UNAVAILABLE')
  assert.ok(Array.isArray(result.rows), 'Invalid SQL snapshot')
  return result.rows
}

export async function selectMesRouteReadyBom (fixture, readSql, caseRecord) {
  const units = rowsOf(await fixture.api.getBusiness('/mes/basUnit/list/enabled'))
  const unitIds = [...new Set(units.map((unit) => id(unit.id)))]
  if (!unitIds.length) throw new EvidenceGap('READY_BOM_ENABLED_UNIT_UNAVAILABLE')
  // The shared order fixture owns one unit-consumption line (2 * 1, no loss).
  const rows = await readRows(readSql, `
    SELECT JSON_OBJECT(
      'bomId', CAST(bom.id AS CHAR), 'bomCode', bom.code,
      'parentId', CAST(parent.id AS CHAR), 'parentCode', parent.code,
      'childId', CAST(child.id AS CHAR), 'childCode', child.code,
      'bomUsage', bom.bom_usage, 'devStatus', CAST(bom.dev_status AS CHAR),
      'stockCount', CAST(bom.stock_count AS CHAR),
      'subStockCount', CAST(sub.sub_stock_count AS CHAR),
      'hasChild', sub.has_child,
      'lossRate', COALESCE(NULLIF(TRIM(sub.loss_rate), ''), '0'),
      'bomUnitId', CAST(bom.unit_id AS CHAR), 'parentUnitId', CAST(parent.unit_id AS CHAR),
      'subUnitId', CAST(sub.unit_id AS CHAR), 'childUnitId', CAST(child.unit_id AS CHAR),
      'activeSubCount', CAST(active_sub.sub_count AS CHAR),
      'availableQty', CAST(stock.available_qty AS CHAR),
      'inventoryRows', CAST(stock.row_count AS CHAR),
      'inventoryUnitRows', CAST(stock.unit_count AS CHAR),
      'inventoryUnitId', CAST(stock.min_unit_id AS CHAR),
      'inventoryMaxUnitId', CAST(stock.max_unit_id AS CHAR))
    FROM mes_wms_assemble bom
    JOIN mes_bas_material parent ON parent.id=bom.stock_id
    JOIN mes_wms_assemble_sub sub ON sub.parent_id=bom.id
    JOIN mes_bas_material child ON child.id=sub.stock_id
    JOIN (
      SELECT parent_id, COUNT(*) AS sub_count FROM mes_wms_assemble_sub
      WHERE tenant_id=1 AND deleted=0 AND COALESCE(is_deleted,0)=0 GROUP BY parent_id
    ) active_sub ON active_sub.parent_id=bom.id AND active_sub.sub_count=1
    JOIN (
      SELECT material_id, SUM(COALESCE(available_qty,qty)) AS available_qty,
             COUNT(*) AS row_count, COUNT(unit_id) AS unit_count,
             MIN(unit_id) AS min_unit_id, MAX(unit_id) AS max_unit_id
      FROM mes_stk_inventory
      WHERE tenant_id=1 AND deleted=0 AND is_closed=0 GROUP BY material_id
    ) stock ON stock.material_id=child.id
    WHERE bom.tenant_id=1 AND bom.deleted=0 AND bom.dev_status=2
      AND bom.bom_usage='PRODUCTION' AND bom.stock_count=1
      AND sub.tenant_id=1 AND sub.deleted=0 AND COALESCE(sub.is_deleted,0)=0
      AND sub.sub_stock_count=1 AND sub.has_child='N'
      AND COALESCE(NULLIF(TRIM(sub.loss_rate), ''), '0') REGEXP '^0+([.]0+)?$'
      AND parent.tenant_id=1 AND parent.deleted=0 AND parent.is_enabled=1
      AND parent.inventory_nature='STOCK'
      AND child.tenant_id=1 AND child.deleted=0 AND child.is_enabled=1
      AND child.inventory_nature='STOCK' AND child.id<>parent.id
      AND bom.unit_id=parent.unit_id AND sub.unit_id=child.unit_id
      AND parent.unit_id=child.unit_id AND child.unit_id IN (${unitIds.map(quote).join(', ')})
      AND stock.available_qty>=2 AND stock.row_count=stock.unit_count
      AND stock.min_unit_id=child.unit_id AND stock.max_unit_id=child.unit_id
    ORDER BY bom.update_time DESC, bom.id DESC LIMIT 1`)
  if (!rows.length) throw new EvidenceGap('READY_BOM_SAMPLE_UNAVAILABLE: existing legal stock must cover quantity 2')
  assert.equal(rows.length, 1, 'Ambiguous ready BOM selection')
  assert.equal(rows[0].length, 1, 'Invalid ready BOM SQL result')
  const candidate = JSON.parse(rows[0][0])
  assert.ok(candidate && typeof candidate === 'object' && !Array.isArray(candidate), 'Invalid ready BOM row')
  for (const field of ['bomId', 'bomCode', 'parentId', 'parentCode', 'childId', 'childCode',
    'bomUsage', 'devStatus', 'stockCount', 'subStockCount', 'lossRate', 'bomUnitId',
    'parentUnitId', 'subUnitId', 'childUnitId', 'activeSubCount', 'availableQty',
    'inventoryRows', 'inventoryUnitRows', 'inventoryUnitId', 'inventoryMaxUnitId', 'hasChild']) {
    requireField(candidate, field, 'READY_BOM')
  }
  for (const field of ['bomId', 'parentId', 'childId']) id(candidate[field])
  assert.notEqual(candidate.parentId, candidate.childId, 'Ready BOM cannot consume its own parent')
  assert.equal(candidate.bomUsage, 'PRODUCTION', 'Ready BOM usage mismatch')
  assert.equal(candidate.devStatus, '2', 'Ready BOM must be enabled')
  assert.equal(candidate.hasChild, 'N', 'Ready BOM child must be a formal leaf')
  for (const field of ['stockCount', 'subStockCount', 'activeSubCount']) {
    assert.match(candidate[field], /^0*1(?:\.0+)?$/, `Ready BOM ${field} must be one`)
  }
  assert.match(candidate.lossRate, /^0+(?:\.0+)?$/, 'Ready BOM must have zero loss')
  assert.match(candidate.availableQty, /^\d+(?:\.\d+)?$/, 'Invalid ready BOM stock quantity')
  assert.ok(BigInt(candidate.availableQty.split('.')[0]) >= 2n, 'Ready BOM has insufficient existing stock')
  assert.match(candidate.inventoryRows, /^[1-9]\d*$/, 'Ready BOM must have real stock rows')
  assert.equal(candidate.inventoryUnitRows, candidate.inventoryRows, 'Missing stock unit evidence')
  const unitId = id(candidate.childUnitId)
  for (const field of ['bomUnitId', 'parentUnitId', 'subUnitId', 'inventoryUnitId', 'inventoryMaxUnitId']) {
    assert.equal(id(candidate[field]), unitId, 'Ready BOM/stock units must match without conversion')
  }
  const unit = units.find((row) => id(row.id) === unitId)
  assert.ok(unit, 'Ready BOM unit is not formally enabled')
  for (const field of ['bomCode', 'parentCode', 'childCode']) {
    assert.ok(typeof candidate[field] === 'string' && candidate[field].trim(), 'Missing ready BOM identity')
  }
  fixture.unit = { ...unit, id: unitId }
  fixture.material = { id: id(candidate.parentId), unitId, identity: candidate.parentCode, shared: true }
  fixture.component = { id: id(candidate.childId), unitId, identity: candidate.childCode, shared: true }
  fixture.bom = { id: id(candidate.bomId), identity: candidate.bomCode, shared: true, devStatus: 2 }
  const evidence = { readOnly: true, ...candidate, requiredQty: '2', claimedQty: '0', sharedCleanup: false }
  fixture.fixtureRecord.enabledBom = {
    bomId: fixture.bom.id, bomCode: fixture.bom.identity, materialId: fixture.material.id,
    componentId: fixture.component.id, devStatus: 2, readiness: evidence
  }
  caseRecord.mesRouteVersionEvidence.readyBom = evidence
  addCheck(caseRecord, MES_ROUTE_VERSION_CHECKS.bom,
    `bom=${fixture.bom.id}; child=${fixture.component.id}; unit=${unitId}; existingAvailable=${candidate.availableQty}; required=2`)
  return evidence
}

export async function verifyMesRouteReleaseGate ({ api, fixture, body, caseRecord }) {
  assert.ok(Array.isArray(body) && body.length === 1, 'MESB006 transfer must target one owned order')
  const orderId = id(fixture.order?.id)
  assert.equal(id(body[0].prodOrderId), orderId, 'MESB006 transfer order ownership mismatch')
  assert.ok(fixture.owned.some((row) => row.kind === 'order' && row.id === orderId &&
    row.marker === fixture.marker && row.identity === fixture.order.identity),
  'MESB006 transfer requires owned order registry')
  const gate = dataOf(await api.getBusiness(`/mes/prodOrder/release-gate?prodOrderId=${orderId}`))
  assert.ok(gate && typeof gate === 'object' && !Array.isArray(gate), 'Missing release-gate API readback')
  for (const field of ['prodOrderId', 'enabled', 'passed', 'items']) requireField(gate, field, 'RELEASE_GATE')
  assert.equal(id(gate.prodOrderId), orderId, 'Release-gate order ownership mismatch')
  assert.equal(typeof gate.enabled, 'boolean', 'Invalid release-gate enabled contract')
  assert.equal(typeof gate.passed, 'boolean', 'Invalid release-gate passed contract')
  assert.ok(Array.isArray(gate.items) && gate.items.length === 2, 'Incomplete release-gate item contract')
  const items = ['BOM', 'MATERIAL'].map((code) => {
    const matches = gate.items.filter((item) => item?.code === code)
    assert.equal(matches.length, 1, 'Missing/duplicate release-gate item')
    assert.equal(typeof matches[0].passed, 'boolean', 'Invalid release-gate item passed contract')
    return { code, passed: matches[0].passed }
  })
  assert.equal(gate.passed, items.every((item) => item.passed), 'Inconsistent release-gate result')
  const evidence = { readOnly: true, prodOrderId: orderId, enabled: gate.enabled, passed: gate.passed, items }
  caseRecord.mesRouteVersionEvidence.releaseGate = evidence
  if (!gate.enabled) throw new EvidenceGap('RELEASE_GATE_NOT_ENABLED: transfer was not called')
  if (!gate.passed) {
    throw new EvidenceGap(`RELEASE_GATE_NOT_PASSED: ${items.filter((item) => !item.passed).map((item) => item.code).join(',')}; transfer was not called`)
  }
  addCheck(caseRecord, MES_ROUTE_VERSION_CHECKS.gate, `order=${orderId}; enabled=true; BOM=true; MATERIAL=true`)
  return evidence
}

export async function auditMesRouteOwnedCleanup (fixture, readSql, caseRecord) {
  assert.ok(typeof fixture.marker === 'string' && fixture.marker.startsWith('AUTOTEST-'),
    'Cleanup audit requires the current dedicated marker')
  const idsFor = (kind) => fixture.owned.filter((row) => row.kind === kind).map((row) => id(row.id))
  const inIds = (column, ids) => ids.length ? [`${column} IN (${ids.map(quote).join(', ')})`] : []
  const orderScope = [`remark=${quote(fixture.marker)}`, ...inIds('id', idsFor('order'))].join(' OR ')
  const workScope = [`remark=${quote(fixture.marker)}`, ...inIds('id', idsFor('work')),
    ...inIds('prod_order_id', idsFor('order'))].join(' OR ')
  const taskScope = [`remark=${quote(fixture.marker)}`, ...inIds('id', idsFor('task')),
    ...inIds('work_ticket_id', idsFor('work')), ...inIds('routing', idsFor('route')),
    `work_ticket_id IN (SELECT id FROM mes_prod_work WHERE tenant_id=1 AND (${workScope}))`].join(' OR ')
  const rows = await readRows(readSql, `
    SELECT 'order', CAST(id AS CHAR), deleted+0, NULL, IF(remark=${quote(fixture.marker)},1,0)
    FROM mes_prod_order WHERE tenant_id=1 AND (${orderScope})
    UNION ALL
    SELECT 'work', CAST(id AS CHAR), deleted+0, CAST(prod_order_id AS CHAR), IF(remark=${quote(fixture.marker)},1,0)
    FROM mes_prod_work WHERE tenant_id=1 AND (${workScope})
    UNION ALL
    SELECT 'task', CAST(id AS CHAR), is_deleted+0, CAST(work_ticket_id AS CHAR), IF(remark=${quote(fixture.marker)},1,0)
    FROM mes_prod_work_task WHERE tenant_id=1 AND (${taskScope})`)
  const resources = fixture.owned.filter((row) => ['order', 'work', 'task'].includes(row.kind))
  const evidence = { readOnly: true, marker: fixture.marker, rows: [], counts: {} }
  caseRecord.mesRouteVersionEvidence.cleanupSnapshot = evidence
  const seen = new Set()
  for (const [kind, rawId, deleted, parentId, markerMatches] of rows) {
    assert.ok(['order', 'work', 'task'].includes(kind), 'Unknown cleanup audit table')
    const resourceId = id(rawId)
    const key = `${kind}:${resourceId}`
    assert.ok(!seen.has(key), 'Duplicate cleanup audit row')
    seen.add(key)
    const resource = resources.find((row) => row.kind === kind && row.id === resourceId)
    assert.ok(resource && resource.marker === fixture.marker, 'Unregistered owned chain residue')
    if (kind !== 'task') assert.equal(String(markerMatches), '1', 'Cleanup audit marker mismatch')
    if (kind !== 'order') {
      assert.ok(idsFor(kind === 'work' ? 'order' : 'work').includes(id(parentId)),
        'Cleanup audit chain ownership mismatch')
    }
    assert.ok(['0', '1'].includes(String(deleted)), 'Invalid cleanup audit deletion evidence')
    const retained = /^RETAINED_AUDIT_/.test(resource.cleanup || '')
    if (!retained) {
      assert.equal(resource.cleanup, 'DELETED_VERIFIED', 'Cleanup registry has no verified terminal state')
      assert.equal(String(deleted), '1', 'Owned chain still has an unretained live row')
    }
    evidence.rows.push({ kind, id: resourceId, deleted: String(deleted), retained })
  }
  for (const resource of resources) {
    if (/^RETAINED_AUDIT_/.test(resource.cleanup || '')) {
      assert.ok(seen.has(`${resource.kind}:${resource.id}`), 'Registered retained chain row is missing')
    } else assert.equal(resource.cleanup, 'DELETED_VERIFIED', 'Unverified owned chain cleanup')
  }
  for (const kind of ['order', 'work', 'task']) {
    const scoped = evidence.rows.filter((row) => row.kind === kind)
    evidence.counts[kind] = {
      any: scoped.length, live: scoped.filter((row) => row.deleted === '0').length,
      retained: scoped.filter((row) => row.retained).length
    }
  }
  evidence.hash = mesRouteFactHash(evidence.rows)
  addCheck(caseRecord, MES_ROUTE_VERSION_CHECKS.cleanupSnapshot, JSON.stringify(evidence.counts))
  return evidence
}

// Enumerate actual columns so newly added, nullable and audit fields are not silently omitted.
export async function readMesRouteFullRows (readSql, table, where) {
  assert.ok(tables.has(table), 'Unsupported evidence table')
  const metadata = await readRows(readSql, `
    SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=${quote(table)} ORDER BY ORDINAL_POSITION`)
  if (!metadata.length) throw new EvidenceGap(`SQL_TABLE_UNAVAILABLE: ${table}`)
  const columns = metadata.map(([name, type]) => {
    assert.match(name, /^[a-z][a-z0-9_]*$/, 'Invalid evidence column')
    assert.match(type, /^[a-z0-9]+$/, 'Invalid evidence type')
    return { name, type }
  })
  assert.equal(new Set(columns.map((column) => column.name)).size, columns.length, 'Duplicate SQL columns')
  for (const key of ['id', 'tenant_id']) {
    if (!columns.some((column) => column.name === key)) throw new EvidenceGap(`SQL_FIELD_UNAVAILABLE: ${key}`)
  }
  const expression = columns.map(({ name, type }) =>
    `${quote(name)}, CAST(${type === 'bit' ? `(\`${name}\`+0)` : `\`${name}\``} AS CHAR)`
  ).join(', ')
  const rows = await readRows(readSql, `
    SELECT JSON_OBJECT(${expression}) FROM \`${table}\`
    WHERE tenant_id=1 AND ${where} ORDER BY id`)
  return rows.map((row) => {
    assert.equal(row.length, 1, 'Invalid full-row SQL result')
    const value = JSON.parse(row[0])
    assert.deepEqual(Object.keys(value).sort(), columns.map((column) => column.name).sort(),
      'Incomplete full-row SQL snapshot')
    assert.equal(value.tenant_id, '1', 'SQL tenant mismatch')
    return value
  })
}

export function assertMesRouteTaskSnapshot (task, sqlTask, fixture, route, node) {
  assert.ok(task && typeof task === 'object' && !Array.isArray(task), 'Missing task API readback')
  assert.ok(sqlTask && typeof sqlTask === 'object', 'Missing task SQL readback')
  for (const field of [...MES_ROUTE_TASK_API_FIELDS, 'taskFields', 'taskMaterials', 'materialAggregates', 'maxReportableQty']) {
    requireField(task, field, 'TASK')
  }
  for (const column of [...MES_ROUTE_TASK_API_FIELDS.map(sqlColumn), 'tenant_id']) {
    requireField(sqlTask, column, 'SQL_TASK')
  }
  assert.equal(id(task.id), id(fixture.tasks[0].id), 'Task registry mismatch')
  assert.equal(id(task.workTicketId), id(fixture.works[0].id), 'Task work ownership mismatch')
  assert.equal(id(task.productId), id(fixture.material.id), 'Task product mismatch')
  assert.equal(id(task.routing), id(route.id), 'Task route mismatch')
  assert.equal(id(task.routeNodeId), id(node.id), 'Task node mismatch')
  assert.equal(id(task.processId), id(fixture.procedure.id), 'Task procedure mismatch')
  assert.equal(task.routeVersion, route.version, 'Task route version mismatch')
  assert.equal(task.remark, fixture.marker, 'Task marker mismatch')
  assert.equal(String(task.status), '5', 'Task must remain dispatched, not started')
  assert.equal(String(task.isDeleted), '0', 'Task must be live')
  assert.equal(task.isEffective, 'Y', 'Task must have been formally made effective')
  assert.equal(sqlTask.tenant_id, '1', 'Task SQL tenant mismatch')
  for (const [field, column] of Object.entries(taskFields)) {
    if (['taskNum', 'workTicketTotal'].includes(field)) {
      assert.ok(task[field] != null && sqlTask[column] != null, 'Missing task quantity')
      assert.equal(Number(task[field]), Number(sqlTask[column]), `SQL/API ${field} mismatch`)
    } else {
      assert.equal(task[field] == null ? null : String(task[field]), sqlTask[column],
        `SQL/API ${field} mismatch`)
    }
  }
  for (const field of ['taskFields', 'taskMaterials', 'materialAggregates']) {
    assert.ok(Array.isArray(task[field]), `Invalid task ${field}`)
  }
  return { api: structuredClone(task), sql: structuredClone(sqlTask) }
}

export function assertMesRouteTaskUnchanged (before, after) {
  assert.ok(before && after, 'Missing before/after task snapshot')
  assert.equal(mesRouteFactHash(after.api), mesRouteFactHash(before.api), 'Complete task API changed')
  assert.equal(mesRouteFactHash(after.sql), mesRouteFactHash(before.sql), 'Complete task SQL row changed')
}

export function finalizeMesRouteVersionAssertions (caseRecord) {
  const names = MES_ROUTE_VERSION_CHECKS
  const bindings = [
    [names.draft, names.frozen, names.configurationDraft,
      names.equipmentFrozen, names.qualityFrozen, names.resourceFrozen],
    [names.upgrade], [names.snapshot], [names.deletion]
  ]
  const uniquePassed = (name) => {
    const matches = caseRecord.checks.filter((check) => check.name === name)
    return matches.length === 1 && matches[0].passed === true
  }
  caseRecord.catalogAssertions = MES_ROUTE_VERSION_ASSERTIONS.map((assertion, index) => {
    const checks = bindings[index].map((name) => caseRecord.checks.filter((check) => check.name === name))
    const verified = bindings[index].every(uniquePassed)
    return {
      index, assertion, status: verified ? 'VERIFIED' : 'GAP', evidenceChecks: bindings[index],
      details: verified ? checks.map(([check]) => check.details).join('; ')
        : `${index === 0 ? MES_ROUTE_RESOURCE_GAP : '本轮缺少完整且唯一通过的具名证据'}; ` +
          bindings[index].filter((name) => !uniquePassed(name)).join('; ')
    }
  })
  caseRecord.remainingAssertions = caseRecord.catalogAssertions.filter((row) => row.status !== 'VERIFIED')
    .map((row) => row.assertion)
  caseRecord.catalogComplete = caseRecord.remainingAssertions.length === 0
  const required = [names.bom, names.gate, names.page, names.configurationPage,
    names.reverse, names.cleanupSnapshot, names.configurationCleanup, names.cleanup]
  caseRecord.remainingEvidence = required.filter((name) => !uniquePassed(name))
  caseRecord.acceptanceComplete = caseRecord.catalogComplete &&
    caseRecord.remainingEvidence.length === 0 &&
    caseRecord.checks.every((check) => check.passed === true)
  caseRecord.passCandidate = caseRecord.acceptanceComplete
  return { partial: !caseRecord.acceptanceComplete, acceptanceComplete: caseRecord.acceptanceComplete,
    passCandidate: caseRecord.passCandidate,
    note: [...caseRecord.remainingAssertions, ...caseRecord.remainingEvidence].join('；') }
}

export async function verifyMesRouteVersionPage ({
  api, page, openRoute, saveScreenshot, outputDir, record, fixture, timeoutMs = 30000
}) {
  const attempt = { startedAt: new Date().toISOString(), steps: [] }
  fixture.routePageEvidence = attempt
  const stage = (name) => {
    attempt.stage = name
    attempt.steps.push({ stage: name, at: new Date().toISOString() })
  }
  stage('permission')
  const permission = dataOf(await api.getBusiness('/system/auth/get-permission-info'))
  assert.ok(Array.isArray(permission?.menus), 'Invalid official permission menu readback')
  const routes = []
  const visit = (menus, parent = '') => {
    for (const menu of menus) {
      const menuPath = String(menu.path || '').split('?')[0].trim()
      const route = (menuPath.startsWith('/') ? menuPath : `${parent}/${menuPath}`).replace(/\/+/g, '/')
      const component = String(menu.component || '').split('?')[0].trim().replace(/^\/?(?:src\/)?views\//, '')
        .replace(/^\/+/, '').replace(/\.vue$/, '').replace(/\/index$/, '')
      if (component === 'mes/produce/technique') routes.push({ route, componentName: menu.componentName })
      if (menu.children) visit(menu.children, route)
    }
  }
  visit(permission.menus)
  if (!routes.length) return { available: false, reason: 'PAGE_ROUTE_UNAVAILABLE' }
  const preferred = routes.filter((menu) => menu.componentName === 'MesProduceTechniqueRoute')
  const selected = preferred.length ? preferred : routes
  assert.equal(selected.length, 1, 'Ambiguous official technique menu')
  const route = selected[0].route
  const failures = []
  const pending = new Set()
  const lists = []
  const pagination = []
  const processPages = new Map()
  const configurationResponses = { detail: [], quality: [] }
  let completed = false
  const completePages = (pages, label) => {
    if (!pages.length) return false
    const total = pages[0].total
    const pageCount = Math.max(1, Math.ceil(total / 100))
    assert.ok(pages.length <= pageCount, `${label} duplicate page response`)
    const seen = new Set()
    for (const entry of pages) {
      assert.equal(entry.total, total, `${label} total changed`)
      assert.ok(entry.pageNo <= pageCount && !seen.has(entry.pageNo),
        `${label} duplicate or out-of-range page response`)
      seen.add(entry.pageNo)
      assert.equal(entry.rowCount, Math.min(100, Math.max(0, total - (entry.pageNo - 1) * 100)),
        `${label} incomplete page response`)
    }
    return pages.length === pageCount
  }
  const paginationComplete = () => {
    return completePages(pagination, 'MESB006 page route')
  }
  const relevant = (url) =>
    /^\/admin-api\/mes\/(?:wmsTechRoute|wmsProcedure|procedure-quality-item)(?:\/|$)/.test(new URL(url).pathname)
  const onResponse = (response) => {
    const request = response.request()
    if (!relevant(response.url())) {
      if ((request.isNavigationRequest() || request.resourceType() === 'script') &&
          !response.ok() && response.status() !== 304) {
        failures.push(new Error('MESB006 official page document/module HTTP failure'))
      }
      return
    }
    const task = (async () => {
      assert.ok(response.ok(), 'MESB006 page API HTTP failure')
      const text = await response.text()
      const payload = response.headers()[ENCRYPT_HEADER.toLowerCase()] === 'true'
        ? decryptResponse(text) : JSON.parse(text)
      const data = dataOf(payload)
      const pathname = new URL(response.url()).pathname
      const params = new URL(response.url()).searchParams
      if (pathname === '/admin-api/mes/wmsProcedure/queryDetailById' &&
          params.get('id') === fixture.procedure.id) {
        configurationResponses.detail.push(structuredClone(data))
      }
      if (pathname === '/admin-api/mes/procedure-quality-item/page' &&
          params.get('procedureId') === fixture.procedure.id) {
        configurationResponses.quality.push(structuredClone(rowsOf(payload)))
      }
      if (pathname === '/admin-api/mes/wmsTechRoute/list' ||
          pathname === '/admin-api/mes/wmsTechRoute/listMesWmsTechRouteSubByMainId') {
        const pageNo = Number(params.get('pageNo'))
        assert.ok(Number.isSafeInteger(pageNo) && pageNo > 0, 'MESB006 page route number invalid')
        assert.equal(params.get('pageSize'), '100', 'MESB006 page route size must be 100')
        const rows = Array.isArray(data) ? data : data?.records ?? data?.list
        assert.ok(Array.isArray(rows), 'MESB006 page route list contract failure')
        assert.ok(data?.total !== undefined && data?.total !== null && data?.total !== '',
          'MESB006 missing page route total')
        const total = Number(data.total)
        assert.ok(Number.isSafeInteger(total) && total >= 0, 'MESB006 page route total invalid')
        const entry = { pageNo, pageSize: 100, total, rowCount: rows.length }
        if (pathname.endsWith('/list')) {
          lists.push(rows)
          pagination.push(entry)
          paginationComplete()
        } else {
          const parentId = id(params.get('parentId'))
          const entries = processPages.get(parentId) ?? []
          const prior = entries.findIndex((item) => item.pageNo === pageNo)
          // Selecting a version again starts a fresh read of its process pages.
          if (pageNo === 1) entries.length = 0
          else assert.equal(prior, -1, 'MESB006 duplicate process page response')
          entries.push({ ...entry, rows })
          processPages.set(parentId, entries)
          completePages(entries, 'MESB006 page process')
        }
      }
    })().catch((error) => failures.push(error)).finally(() => pending.delete(task))
    pending.add(task)
  }
  const onFailed = (request) => {
    const failure = {
      url: request.url(),
      resourceType: request.resourceType(),
      error: request.failure()?.errorText
    }
    if (isExpectedRequestFailure(failure)) return
    if (relevant(request.url()) || request.resourceType() === 'script' || request.isNavigationRequest()) {
      failures.push(new Error('MESB006 official page request failed'))
    }
  }
  const onError = () => failures.push(new Error('MESB006 official page runtime failure'))
  const healthy = () => { if (failures.length) throw failures[0] }
  const flush = async (requireList = false) => {
    const deadline = Date.now() + timeoutMs
    while (pending.size || (requireList && !paginationComplete())) {
      healthy()
      assert.ok(Date.now() < deadline, 'MESB006 missing successful page API response')
      await delay(10)
    }
    healthy()
  }
  page.on('response', onResponse)
  page.on('requestfailed', onFailed)
  page.on('pageerror', onError)
  try {
    stage('navigation')
    await openRoute(page, route, { readySelector: '.technique-route' })
    stage('route-api')
    await page.locator('.technique-route').waitFor({ state: 'visible', timeout: timeoutMs })
    await flush(true)
    const owned = lists.flat().filter((row) => row.code === fixture.route.identity &&
      row.mark === fixture.marker && row.name === `${fixture.marker}-ROUTE`)
    assert.ok(owned.some((row) => id(row.id) === fixture.route.id && row.version === 'V1.0'),
      'MESB006 page API omitted original owned route')
    assert.ok(owned.some((row) => id(row.id) !== fixture.route.id && row.version === 'V1.1'),
      'MESB006 page API omitted upgraded owned route')
    await page.locator('.technique-route-tree input').fill(`${fixture.marker}-ROUTE`)
    await page.locator('.technique-route-tree').getByText(`${fixture.marker}-ROUTE V1.0`, { exact: true })
      .waitFor({ state: 'visible', timeout: timeoutMs })
    await page.locator('.technique-route-tree').getByText(`${fixture.marker}-ROUTE V1.1`, { exact: true })
      .waitFor({ state: 'visible', timeout: timeoutMs })
    const processViews = []
    for (const version of ['V1.0', 'V1.1']) {
      stage(`version-${version}`)
      const routeRow = owned.filter((row) => row.version === version)
      assert.equal(routeRow.length, 1, 'MESB006 duplicate owned version')
      const routeId = id(routeRow[0].id)
      processPages.delete(routeId)
      await page.locator('.technique-route-tree').getByText(`${fixture.marker}-ROUTE ${version}`, { exact: true })
        .click()
      const deadline = Date.now() + timeoutMs
      while (!completePages(processPages.get(routeId) ?? [], 'MESB006 page process')) {
        healthy()
        assert.ok(Date.now() < deadline, 'MESB006 missing complete selected version process response')
        await delay(10)
      }
      await flush()
      const pages = processPages.get(routeId)
      const nodes = pages.flatMap((entry) => entry.rows)
      assert.equal(nodes.length, 1, 'MESB006 selected version must contain its one owned process')
      const node = nodes[0]
      assert.equal(id(node.parentId), routeId, 'MESB006 page process route mismatch')
      assert.equal(id(node.procedureId), id(fixture.procedure.id), 'MESB006 page process identity mismatch')
      assert.equal(node.mark, fixture.marker, 'MESB006 page process marker mismatch')
      const procedureName = fixture.routeConfiguration?.latest?.api.detail.name ?? fixture.procedure.identity
      assert.equal(node.procedureName, procedureName, 'MESB006 page process label mismatch')
      const visual = page.locator(`.vue-flow-container .vue-flow__node[data-id="${id(node.id)}"]`)
      await visual.waitFor({ state: 'visible', timeout: timeoutMs })
      await visual.locator('.node-title').getByText(procedureName, { exact: true })
        .waitFor({ state: 'visible', timeout: timeoutMs })
      let bounds
      let canvas
      const renderDeadline = Date.now() + timeoutMs
      for (;;) {
        healthy()
        bounds = await visual.boundingBox()
        canvas = await page.locator('.vue-flow-container').boundingBox()
        if (bounds && canvas && bounds.width > 0 && bounds.height > 0 &&
            canvas.width > 0 && canvas.height > 0 &&
            bounds.x < canvas.x + canvas.width && bounds.x + bounds.width > canvas.x &&
            bounds.y < canvas.y + canvas.height && bounds.y + bounds.height > canvas.y) break
        assert.ok(Date.now() < renderDeadline,
          `MESB006 selected process is blank or outside the canvas: ${JSON.stringify({ bounds, canvas })}`)
        await delay(50)
      }
      processViews.push({ routeId, version, nodeId: id(node.id), procedureId: id(node.procedureId),
        pagination: pages.map(({ rows, ...entry }) => entry), bounds, canvas })
      await saveScreenshot(page, outputDir, `mes-base-006-route-version-${version}`, record)
      if (fixture.routeConfiguration?.latest) {
        stage(`configuration-${version}`)
        const expected = fixture.routeConfiguration.latest.api
        const refs = fixture.routeConfiguration.references
        await visual.click()
        const panel = page.locator('.route-procedure-config')
        await panel.waitFor({ state: 'visible', timeout: timeoutMs })
        const configurationDeadline = Date.now() + timeoutMs
        for (;;) {
          healthy()
          const loadingMasks = await panel.locator('.el-loading-mask:visible').count()
          const detailReceived = configurationResponses.detail.some((row) => id(row.id) === fixture.procedure.id)
          if (loadingMasks === 0 && detailReceived && configurationResponses.quality.length > 0) break
          assert.ok(Date.now() < configurationDeadline,
            'MESB006 configuration API/loading did not finish before checking pointer reachability')
          await delay(10)
        }
        await flush()
        const layout = await panel.evaluate(async (element) => {
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          const bounds = (target) => {
            if (!target) return null
            const rect = target.getBoundingClientRect()
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          }
          const tabs = ['mainResource', 'quality'].map((key) => {
            const tab = element.querySelector(`[role="tab"][id="tab-${key}"]`)
            const rect = bounds(tab)
            const centerX = rect ? rect.x + rect.width / 2 : -1
            const centerY = rect ? rect.y + rect.height / 2 : -1
            const hit = document.elementFromPoint(centerX, centerY)
            return { key, bounds: rect, pointerReachable: Boolean(tab && rect.width > 0 &&
              rect.height > 0 && hit && tab.contains(hit)),
            hitTag: hit?.tagName ?? null, hitClass: typeof hit?.className === 'string' ? hit.className : null }
          })
          return { panel: bounds(element),
            basic: bounds(element.querySelector('.route-procedure-config__basic')),
            detail: bounds(element.querySelector('.route-procedure-config__detail')),
            viewport: { width: innerWidth, height: innerHeight }, tabs,
            passed: tabs[0].pointerReachable }
        })
        if (layout.passed !== true) {
          processViews.at(-1).configuration = {
            procedureId: fixture.procedure.id, domAndApiSucceeded: false,
            reason: 'CONFIGURATION_PANEL_LAYOUT_BLOCKED', layout
          }
          await saveScreenshot(page, outputDir, `mes-base-006-route-config-layout-${version}`, record)
          continue
        }
        await panel.getByRole('tab', { name: '主资源', exact: true }).click()
        const main = panel.locator('.el-tab-pane:visible .el-table__body-wrapper tbody tr')
        await main.getByText(refs.resourceCode, { exact: true }).waitFor({ state: 'visible', timeout: timeoutMs })
        const mainRows = await main.allTextContents()
        assert.equal(mainRows.length, 1, 'MESB006 resource DOM must contain exactly one row')
        assert.ok(mainRows[0].includes(refs.resourceCode) && mainRows[0].includes(refs.resourceName),
          'MESB006 resource DOM identity mismatch')
        const capacityText = (await main.locator('td').nth(5).innerText()).trim()
        assert.equal(decimal(capacityText), decimal(expected.detail.mainResources[0].capacity),
          'MESB006 resource DOM capacity mismatch')
        await saveScreenshot(page, outputDir, `mes-base-006-route-resource-${version}`, record)
        await panel.getByRole('tab', { name: '质检', exact: true }).click()
        const quality = panel.locator('.bound-quality-scheme')
        await quality.locator('.scheme-name').getByText(refs.planName, { exact: true })
          .waitFor({ state: 'visible', timeout: timeoutMs })
        await quality.locator('.item-name').getByText(refs.itemName, { exact: true })
          .waitFor({ state: 'visible', timeout: timeoutMs })
        const qualityItems = quality.locator('.quality-item-card')
        assert.equal(await qualityItems.count(), 1, 'MESB006 quality DOM must contain exactly one item')
        await qualityItems.getByText(expected.quality[0].target, { exact: true })
          .waitFor({ state: 'visible', timeout: timeoutMs })
        await qualityItems.getByText(expected.quality[0].frequency, { exact: true })
          .waitFor({ state: 'visible', timeout: timeoutMs })
        await qualityItems.getByText('必检', { exact: true }).waitFor({ state: 'visible', timeout: timeoutMs })
        await flush()
        assert.ok(configurationResponses.detail.some((row) => id(row.id) === fixture.procedure.id &&
          mesRouteFactHash(row.mainResources) === mesRouteFactHash(expected.detail.mainResources)),
        'MESB006 resource browser API evidence missing or drifted')
        assert.ok(configurationResponses.quality.some((rows) =>
          mesRouteFactHash(rows) === mesRouteFactHash(expected.quality)),
        'MESB006 quality browser API evidence missing or drifted')
        processViews.at(-1).configuration = {
          procedureId: fixture.procedure.id, resourceCode: refs.resourceCode,
          capacity: capacityText, qualityPlanId: refs.planId, qualityItemId: refs.itemId,
          target: expected.quality[0].target, frequency: expected.quality[0].frequency,
          resourceApiHash: mesRouteFactHash(expected.detail.mainResources),
          qualityApiHash: mesRouteFactHash(expected.quality), domAndApiSucceeded: true, layout
        }
        await saveScreenshot(page, outputDir, `mes-base-006-route-quality-${version}`, record)
      }
    }
    const text = await page.locator('body').innerText()
    assert.ok(!/模块配置异常|页面不存在|无权访问|权限不足|无访问权限|(?:^|\s)404(?:\s|$)|Forbidden/i.test(text),
      'MESB006 official page error/permission DOM')
    await saveScreenshot(page, outputDir, 'mes-base-006-route-version', record)
    await flush()
    stage('complete')
    attempt.finishedAt = new Date().toISOString()
    completed = true
    return { available: true, route, ownedRouteIds: [...new Set(owned.map((row) => id(row.id)))],
      pagination, processViews, timing: attempt,
      screenshot: 'mes-base-006-route-version', domAndApiSucceeded: true,
      configurationSucceeded: processViews.length === 2 &&
        processViews.every((view) => view.configuration?.domAndApiSucceeded === true) }
  } catch (caught) {
    attempt.failedAt = new Date().toISOString()
    attempt.error = { name: caught.name, message: caught.message }
    throw caught
  } finally {
    page.off('response', onResponse)
    page.off('requestfailed', onFailed)
    page.off('pageerror', onError)
    const pendingTasks = [...pending]
    if (pendingTasks.length) {
      let timer
      try {
        const settled = await Promise.race([
          Promise.allSettled(pendingTasks).then(() => true),
          new Promise((resolve) => { timer = setTimeout(() => resolve(false), Math.min(timeoutMs, 5000)) })
        ])
        if (completed) {
          assert.ok(settled, 'MESB006 page response cleanup timed out')
          healthy()
        }
      } finally {
        clearTimeout(timer)
      }
    }
  }
}

export async function runMesRouteVersionClosure ({ api, record, caseRecord, tenantId, verifyPage, dependencies = {} }) {
  const names = MES_ROUTE_VERSION_CHECKS
  caseRecord.mesRouteVersionEvidence = { runId: record.runId, snapshots: [], retained: [] }
  finalizeMesRouteVersionAssertions(caseRecord)
  assertMesRouteVersionTarget(record, dependencies.settings ?? config,
    dependencies.writeFlag ?? process.env.CFOR_E2E_WRITE_FIXTURES, tenantId)
  await (dependencies.assertLocalWriteSafety ?? assertLocalWriteSafety)(caseRecord)
  const readSql = dependencies.runReadOnlySql ?? runReadOnlySql
  let fixture
  const scopedApi = mesRouteVersionScopedApi(api, {
    beforeTransfer: (body) => verifyMesRouteReleaseGate({ api: scopedApi, fixture, body, caseRecord }),
    allowConfigurationWrite: (method, path, body) => assertMesRouteConfigurationWrite(fixture, method, path, body)
  })
  fixture = (dependencies.createFixture ?? ((...args) => new ExecutionWorkflowFixture(...args)))(
    scopedApi, record, 'MES-BASE-006', { ...MES_ROUTE_VERSION_OPTIONS })
  const hadOwnSelector = Object.hasOwn(fixture, 'selectEnabledBom')
  const originalSelector = fixture.selectEnabledBom
  fixture.selectEnabledBom = () => selectMesRouteReadyBom(fixture, readSql, caseRecord)
  const published = new Set()
  const retained = new Set()
  let beforeTask
  let error
  let preparing = true
  const routePath = (routeId) => `/mes/wmsTechRoute/queryById?id=${id(routeId)}`
  const routeCode = () => fixture.route?.identity ?? `${fixture.shortCode}-RT`
  const readRoute = async (routeId) => {
    const route = dataOf(await scopedApi.getBusiness(routePath(routeId)))
    assert.ok(route && typeof route === 'object', 'Missing route API readback')
    for (const key of ['id', 'code', 'name', 'mark', 'version', 'devStatus']) requireField(route, key, 'ROUTE')
    assert.equal(id(route.id), id(routeId), 'Route ID mismatch')
    assert.equal(route.code, routeCode(), 'Route code ownership mismatch')
    assert.equal(route.name, `${fixture.marker}-ROUTE`, 'Route name ownership mismatch')
    assert.equal(route.mark, fixture.marker, 'Route marker ownership mismatch')
    return route
  }
  const readRouteFacts = async (routeId) => {
    const route = await readRoute(routeId)
    const nodes = rowsOf(await scopedApi.getBusiness(
      `/mes/wmsTechRoute/listMesWmsTechRouteSubByMainId?parentId=${id(routeId)}&pageNo=1&pageSize=100`))
    assert.equal(nodes.length, 1, 'Owned route must have one node')
    assert.equal(id(nodes[0].parentId), id(routeId), 'Route node ownership mismatch')
    const main = await readMesRouteFullRows(readSql, 'mes_wms_tech_route', `id=${quote(id(routeId))}`)
    const subs = await readMesRouteFullRows(readSql, 'mes_wms_tech_route_sub', `parent_id=${quote(id(routeId))} AND deleted=0`)
    assert.equal(main.length, 1, 'Missing owned route SQL row')
    assert.equal(subs.length, 1, 'Missing owned route SQL node')
    for (const [field, column] of [['code', 'code'], ['mark', 'mark'], ['version', 'version'], ['devStatus', 'dev_status']]) {
      requireField(main[0], column, 'SQL_ROUTE')
      assert.equal(String(route[field]), main[0][column], `Route SQL/API ${field} mismatch`)
    }
    assert.equal(id(nodes[0].id), id(subs[0].id), 'Route node SQL/API mismatch')
    assert.equal(id(subs[0].procedure_id), id(fixture.procedure.id), 'Route node procedure mismatch')
    return { api: { route, nodes }, sql: { main, subs } }
  }
  const captureTask = async (phase, facts) => {
    const task = dataOf(await scopedApi.getBusiness(`/mes/prodWorkTask/queryById?id=${id(fixture.tasks[0].id)}`))
    const sqlTasks = await readMesRouteFullRows(readSql, 'mes_prod_work_task',
      `work_ticket_id=${quote(id(fixture.works[0].id))} AND is_deleted=0`)
    assert.equal(sqlTasks.length, 1, 'Task SQL scope must contain exactly one task')
    const snapshot = assertMesRouteTaskSnapshot(task, sqlTasks[0], fixture, facts.api.route, facts.api.nodes[0])
    const evidence = {
      phase, taskId: id(task.id), routeVersion: task.routeVersion, routeNodeId: id(task.routeNodeId),
      apiFields: Object.keys(task).sort(), sqlFields: Object.keys(sqlTasks[0]).sort(),
      apiHash: mesRouteFactHash(snapshot.api), sqlHash: mesRouteFactHash(snapshot.sql)
    }
    caseRecord.mesRouteVersionEvidence.snapshots.push(evidence)
    caseRecord.database = [...(caseRecord.database || []), { stage: `mes-route-version-${phase}`,
      readOnly: true, table: 'mes_prod_work_task', ...evidence }]
    return snapshot
  }
  const discoverRoutes = async () => {
    const rows = rowsOf(await scopedApi.getBusiness(
      `/mes/wmsTechRoute/list?pageNo=1&pageSize=100&name=${encodeURIComponent(`${fixture.marker}-ROUTE`)}`))
    const owned = rows.filter((row) => row.mark === fixture.marker &&
      row.code === routeCode() && row.name === `${fixture.marker}-ROUTE`)
    for (const row of owned) {
      if (!fixture.owned.some((item) => item.kind === 'route' && item.id === id(row.id))) {
        fixture.remember('route', id(row.id), row.code)
      }
    }
    return owned
  }
  const discoverTasks = async () => {
    if (!fixture.route || !fixture.works.length) return
    const tasks = rowsOf(await scopedApi.getBusiness(
      `/mes/prodWorkTask/list?pageNo=1&pageSize=100&workTicketId=${id(fixture.works[0].id)}`))
    for (const task of tasks) {
      fixture.assertOwnedTask(task)
      if (!fixture.tasks.some((row) => id(row.id) === id(task.id))) {
        fixture.tasks.push({ ...task, id: id(task.id) })
      }
      if (!fixture.owned.some((row) => row.kind === 'task' && row.id === id(task.id))) {
        fixture.remember('task', id(task.id), task.workOrderTaskCode)
      }
    }
  }
  const requirePublished = (facts) => {
    const route = facts.api.route
    assert.equal(Number(route.devStatus), 2, 'Route must be genuinely published before scheduling')
    for (const key of ['publishTime', 'publishBy']) {
      requireField(route, key, 'ROUTE')
      assert.ok(route[key], 'Missing route publication audit')
    }
    assert.ok(facts.sql.main[0].publish_time && facts.sql.main[0].publish_by, 'Missing SQL publication audit')
    published.add(id(route.id))
  }
  const assertFactsUnchanged = (before, after) => {
    assert.equal(mesRouteFactHash(after), mesRouteFactHash(before), 'Complete route API/SQL facts changed')
  }
  try {
    await fixture.setup(caseRecord)
    preparing = false
    assert.ok(!fixture.opening && fixture.withOpeningInventory === false && fixture.reuseEnabledBom === true,
      'Unsafe execution fixture options')
    assert.equal(fixture.tasks.length, 0, 'Task must not be scheduled before route publication')
    const draft = await readRouteFacts(fixture.route.id)
    assert.equal(Number(draft.api.route.devStatus), 0, 'Owned route must start as draft')
    assert.equal(draft.api.route.version, 'V1.0', 'Owned route must start at V1.0')
    const body = (facts) => ({
      ...Object.fromEntries(['id', 'code', 'name', 'version', 'type', 'mark', 'isStrict', 'designMode', 'inboundType']
        .filter((key) => Object.hasOwn(facts.api.route, key)).map((key) => [key, facts.api.route[key]])),
      notes: `${fixture.marker}-EDIT`,
      wmsTechRouteSubList: facts.api.nodes.map((node) => Object.fromEntries(
        ['id', 'parentId', 'procedureId', 'procedureName', 'sortOrder', 'mark', 'isFeed', 'isQuality',
          'isFinished', 'isVirtualNode', 'outsourceFlag'].filter((key) => Object.hasOwn(node, key))
          .map((key) => [key, node[key]])))
    })
    dataOf(await scopedApi.postBusiness('/mes/wmsTechRoute/editMain', body(draft)))
    const edited = await readRouteFacts(fixture.route.id)
    assert.equal(edited.api.route.version, draft.api.route.version, 'Draft version changed')
    assert.equal(edited.api.route.notes, `${fixture.marker}-EDIT`, 'Draft edit not read back')
    addCheck(caseRecord, names.draft, `route=${fixture.route.id}; version=${edited.api.route.version}`)
    await (dependencies.prepareConfiguration ?? prepareMesRouteConfiguration)(fixture, readSql, caseRecord)
    dataOf(await scopedApi.postBusiness(`/mes/wmsTechRoute/publish?id=${id(fixture.route.id)}`))
    const original = await readRouteFacts(fixture.route.id)
    requirePublished(original)
    await fixture.scheduleTask()
    beforeTask = await captureTask('published-before-upgrade', original)
    const frozenContract = { code: 400,
      message: '工艺路线已发布，节点、顺序、资源、质检和委外属性不可原地修改，请新建版本' }
    const node = original.api.nodes[0]
    for (const [label, endpoint, payload] of [
      ['主档', '/mes/wmsTechRoute/edit', { id: fixture.route.id, notes: `${fixture.marker}-FORBIDDEN` }],
      ['节点', '/mes/wmsTechRoute/addMesWmsTechRouteSub', { parentId: fixture.route.id,
        procedureId: fixture.procedure.id, sortOrder: 2, mark: fixture.marker }],
      ['顺序', '/mes/wmsTechRoute/editMesWmsTechRouteSub', { id: node.id, parentId: fixture.route.id, sortOrder: 2 }],
      ['质检属性', '/mes/wmsTechRoute/editMesWmsTechRouteSub', { id: node.id, parentId: fixture.route.id, isQuality: 1 }],
      ['委外属性', '/mes/wmsTechRoute/editMesWmsTechRouteSub', { id: node.id, parentId: fixture.route.id, outsourceFlag: 1 }]
    ]) {
      const rejected = await scopedApi.request('POST', endpoint, payload, { expectedBusinessRejection: frozenContract })
      assert.ok(matchesExpectedBusinessRejection(rejected, frozenContract), `Unexpected published ${label} rejection`)
      assertFactsUnchanged(original, await readRouteFacts(fixture.route.id))
    }
    addCheck(caseRecord, names.frozen, '主档/节点/顺序/质检属性/委外属性精确400拒绝，完整主子表API/SQL哈希不变')
    const deletion = { code: 400, message: '工艺路线已发布，不能直接删除，请先停用或新建版本' }
    const rejectedDelete = await scopedApi.request('DELETE',
      `/mes/wmsTechRoute/delete?id=${id(fixture.route.id)}`, undefined, { expectedBusinessRejection: deletion })
    assert.ok(matchesExpectedBusinessRejection(rejectedDelete, deletion), 'Unexpected published delete rejection')
    assertFactsUnchanged(original, await readRouteFacts(fixture.route.id))
    addCheck(caseRecord, names.deletion, `route=${fixture.route.id}; exact400; unchanged=true`)

    dataOf(await scopedApi.postBusiness('/mes/wmsTechRoute/editMain', body(original)))
    const versions = await discoverRoutes()
    const newer = versions.filter((row) => id(row.id) !== id(fixture.route.id))
    assert.equal(newer.length, 1, 'Upgrade must create exactly one owned version')
    const upgraded = await readRouteFacts(newer[0].id)
    assert.equal(upgraded.api.route.version, 'V1.1', 'Unexpected upgraded route version')
    assert.equal(Number(upgraded.api.route.devStatus), 0, 'Upgraded route must start as draft')
    assert.notEqual(id(upgraded.api.nodes[0].id), id(node.id), 'Cloned node reused old node ID')
    assertFactsUnchanged(original, await readRouteFacts(fixture.route.id))
    addCheck(caseRecord, names.upgrade, `old=${fixture.route.id}@V1.0; draft=${newer[0].id}@V1.1; oldFactsUnchanged=true`)
    assertMesRouteTaskUnchanged(beforeTask, await captureTask('upgraded-draft', original))
    dataOf(await scopedApi.postBusiness(`/mes/wmsTechRoute/publish?id=${id(newer[0].id)}`))
    requirePublished(await readRouteFacts(newer[0].id))
    assertMesRouteTaskUnchanged(beforeTask, await captureTask('upgraded-published', original))
    await (dependencies.verifyConfigurationFrozen ?? verifyMesRouteConfigurationFrozen)(fixture, readSql, caseRecord)
    try {
      assertMesRouteTaskUnchanged(beforeTask, await captureTask('configuration-probed', original))
      addCheck(caseRecord, names.snapshot,
        `task=${fixture.tasks[0].id}; fullAPI/fullSQL; routeVersion=V1.0; routeNodeId=${node.id}; draft/publishedUpgrade/configurationProbesUnchanged=true`)
    } catch (caught) {
      caseRecord.checks.push({ name: names.snapshot, passed: false,
        details: caught.code === 'ERR_ASSERTION' ? caught.message : caught.name })
    }
    if (verifyPage) {
      const pageEvidence = await verifyPage({ fixture, api: scopedApi })
      assert.ok(pageEvidence && typeof pageEvidence.available === 'boolean', 'Invalid page audit result')
      caseRecord.mesRouteVersionEvidence.page = pageEvidence
      if (fixture.routePageEvidence) {
        caseRecord.mesRouteVersionEvidence.pageAttempt = fixture.routePageEvidence
      }
      if (pageEvidence.available && pageEvidence.domAndApiSucceeded === true) {
        addCheck(caseRecord, names.page, pageEvidence.route)
        caseRecord.checks.push({ name: names.configurationPage,
          passed: pageEvidence.configurationSucceeded === true,
          details: JSON.stringify(pageEvidence.processViews ?? { reason: 'CONFIGURATION_PAGE_EVIDENCE_UNAVAILABLE' }) })
      }
      else caseRecord.notes.push(`MESB006 GAP: ${pageEvidence.reason}`)
    } else {
      caseRecord.notes.push('MESB006 GAP: PAGE_AUDIT_UNAVAILABLE')
    }
  } catch (caught) {
    error = caught
    if (fixture.routePageEvidence) {
      caseRecord.mesRouteVersionEvidence.pageAttempt = fixture.routePageEvidence
    }
    const setupPrerequisiteUnavailable = preparing && caught.code === 'ERR_ASSERTION' &&
      ['BLOCKED: 没有可复用计量单位', 'BLOCKED: 当前账号没有可见车间'].includes(caught.message)
    if (caught instanceof EvidenceGap || setupPrerequisiteUnavailable) {
      caseRecord.notes.push(`MESB006 GAP: ${caught.message}`)
      error = null
    } else {
      caseRecord.checks.push({ name: 'MESB006 契约执行与事实回读', passed: false,
        details: caught.code === 'ERR_ASSERTION' ? caught.message : caught.name })
    }
  } finally {
    const cleanupErrors = []
    const cleanResource = fixture.cleanupResource
    try {
      if (fixture.procedure?.id) {
        const discovered = await discoverRoutes()
        if (!fixture.route) {
          const originals = discovered.filter((row) => row.version === 'V1.0')
          assert.ok(originals.length <= 1, 'Ambiguous owned original route')
          if (originals.length) fixture.route = fixture.owned.find((row) =>
            row.kind === 'route' && row.id === id(originals[0].id))
        }
        await discoverTasks()
        for (const resource of fixture.owned.filter((item) => item.kind === 'route')) {
          const route = await readRoute(resource.id)
          if (Number(route.devStatus) === 2) published.add(resource.id)
          if (!published.has(resource.id)) continue
          if (Number(route.devStatus) === 2) {
            dataOf(await scopedApi.postBusiness(`/mes/wmsTechRoute/unpublish?id=${id(resource.id)}`))
          }
          const disabled = await readRouteFacts(resource.id)
          assert.equal(Number(disabled.api.route.devStatus), 3, 'Published route cleanup must disable, not delete')
          retained.add(resource.id)
          caseRecord.mesRouteVersionEvidence.retained.push({
            kind: 'route', id: resource.id, cleanup: 'RETAINED_AUDIT_DISABLED',
            nodeIds: disabled.api.nodes.map((node) => id(node.id)), hash: mesRouteFactHash(disabled)
          })
        }
        if (beforeTask && retained.has(fixture.route.id)) {
          try {
            const disabledFacts = await readRouteFacts(fixture.route.id)
            assertMesRouteTaskUnchanged(beforeTask, await captureTask('disabled-before-cleanup', disabledFacts))
            addCheck(caseRecord, names.reverse, `route=${fixture.route.id}; DISABLED; taskFullHashesUnchanged=true`)
          } catch (caught) {
            caseRecord.checks.push({ name: names.reverse, passed: false,
              details: caught.code === 'ERR_ASSERTION' ? caught.message : caught.name })
          }
        }
      }
    } catch (caught) {
      cleanupErrors.push(caught)
    }
    // Keep published routes and their referenced principals in the same owned registry.
    fixture.cleanupResource = async (resource, cleanupRecord) => {
      if ((resource.kind === 'route' && published.has(resource.id)) ||
          (published.size && ['procedure', 'team'].includes(resource.kind))) {
        try {
          await fixture.assertCleanupOwnership(resource)
          if (resource.kind === 'route') assert.ok(retained.has(resource.id), 'Route retention not verified')
          resource.cleanup = resource.kind === 'route' ? 'RETAINED_AUDIT_DISABLED' : 'RETAINED_AUDIT_ROUTE_REFERENCE'
          if (resource.kind !== 'route') {
            caseRecord.mesRouteVersionEvidence.retained.push({
              kind: resource.kind, id: resource.id, cleanup: resource.cleanup, referencedRoutes: [...published]
            })
          }
          return true
        } catch (caught) {
          resource.cleanup = 'RETAINED_UNVERIFIED'
          cleanupErrors.push(caught)
          return false
        }
      }
      return cleanResource.call(fixture, resource, cleanupRecord)
    }
    try {
      await (dependencies.prepareConfigurationCleanup ?? prepareMesRouteConfigurationCleanup)(fixture, readSql, published)
    } catch (caught) {
      cleanupErrors.push(caught)
    }
    try {
      await fixture.cleanup(caseRecord)
      assert.equal(fixture.fixtureRecord.cleanup, 'VERIFIED', 'Execution registry cleanup incomplete')
      assert.ok(fixture.owned.every((resource) => resource.cleanup &&
        resource.cleanup !== 'RETAINED_UNVERIFIED'), 'Unaccounted owned resource')
      assert.ok(!fixture.owned.some((resource) =>
        ['opening', 'inventory', 'pickBill', 'report', 'output'].includes(resource.kind)), 'Forbidden resource registered')
    } catch (caught) {
      cleanupErrors.push(caught)
    } finally {
      fixture.cleanupResource = cleanResource
      if (hadOwnSelector) fixture.selectEnabledBom = originalSelector
      else delete fixture.selectEnabledBom
    }
    try {
      await auditMesRouteOwnedCleanup(fixture, readSql, caseRecord)
    } catch (caught) {
      cleanupErrors.push(caught)
      caseRecord.checks.push({ name: names.cleanupSnapshot, passed: false,
        details: caught.code === 'ERR_ASSERTION' ? caught.message : caught.name })
    }
    try {
      await (dependencies.auditConfigurationCleanup ?? auditMesRouteConfigurationCleanup)(
        fixture, readSql, caseRecord, published)
    } catch (caught) {
      cleanupErrors.push(caught)
      caseRecord.checks.push({ name: names.configurationCleanup, passed: false,
        details: caught.code === 'ERR_ASSERTION' ? caught.message : caught.name })
    }
    caseRecord.checks.push({
      name: names.cleanup, passed: cleanupErrors.length === 0,
      details: `registry=${fixture.owned.length}; retained=${caseRecord.mesRouteVersionEvidence.retained.length}; errors=${cleanupErrors.length}`
    })
    finalizeMesRouteVersionAssertions(caseRecord)
    if (caseRecord.catalogAssertions[0].status !== 'VERIFIED') {
      caseRecord.notes.push(`MESB006 GAP: ${MES_ROUTE_RESOURCE_GAP}`)
    }
    if (cleanupErrors.length) {
      error = new AggregateError([error, ...cleanupErrors].filter(Boolean), 'MESB006 cleanup/snapshot verification failed')
    }
  }
  if (error) throw error
  return finalizeMesRouteVersionAssertions(caseRecord)
}
