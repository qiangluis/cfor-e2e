import { createHash, randomUUID } from 'node:crypto'
import { config } from '../config/index.mjs'
import { assertBusinessSuccess } from './assertions.mjs'

export const WMS_FIXTURE_MARK = 'E2E-WMS-20261007 dedicated fixture'
export const WMS_WRITE_ENV = 'CFOR_E2E_WRITE_FIXTURES'

export const isWmsWriteEnabled = (env = process.env) =>
  String(env[WMS_WRITE_ENV] || '').trim().toLowerCase() === 'true'

export const dataOf = (response, label = 'WMS response') => {
  assertBusinessSuccess(response, label)
  return response && Object.prototype.hasOwnProperty.call(response, 'data')
    ? response.data
    : response
}

export const rowsOf = (response, label = 'WMS list') => {
  const data = dataOf(response, label)
  const rows = Array.isArray(data) ? data : data?.records ?? data?.list
  if (!Array.isArray(rows)) throw new Error(`${label} 未返回数组`) 
  return rows
}

export const fixtureToken = (kind) =>
  `E2E-WMS-${kind}-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${process.pid}-${randomUUID().slice(0, 8)}`

export const fixtureCode = (token, kind, index = 1) => {
  const digest = createHash('sha256').update(`${token}${kind}${index}`).digest('hex').slice(0, 20)
  return `${kind}-${digest}`
}

const isEffective = (detail) => Number(detail?.isEffective || 0) === 1

export const isOwnedFixture = (row, token) => {
  if (!row || !token) return false
  const text = [row.code, row.name, row.mark, row.remark, row.billNo, row.subject]
    .filter((value) => value !== undefined && value !== null).join(' ')
  return text.includes(token) || text.includes(WMS_FIXTURE_MARK)
}

export const assertLocalWmsWriteTarget = ({ target = config.target, webBase = config.webBase,
  apiBase = config.apiBase, tenantId = config.tenantId, tenantName = config.tenantName } = {}) => {
  if (target !== 'local') throw new Error('BLOCKED: WMS 写侧仅允许 local 目标')
  const loopback = new Set(['127.0.0.1', 'localhost', '[::1]'])
  for (const [label, value, port] of [['前端', webBase, '9151'], ['后端', apiBase, '48083']]) {
    const url = new URL(value)
    if (!loopback.has(url.hostname) || url.port !== port) {
      throw new Error(`BLOCKED: WMS ${label} 必须使用回环端口 ${port}`)
    }
  }
  if (String(tenantId) !== '1' || tenantName !== 'CFOR 标准平台') {
    throw new Error('BLOCKED: WMS 写侧仅允许租户 1 / CFOR 标准平台')
  }
}

const remember = (caseRecord, fixture) => {
  caseRecord.fixtures = [...(caseRecord.fixtures || []), fixture]
  return fixture
}

const addCheck = (caseRecord, name, passed, details = '') => {
  caseRecord.checks.push({ name, passed: Boolean(passed), details })
  return passed
}

const findWarehouse = (rows, code, name) => {
  const walk = (nodes) => {
    for (const row of nodes || []) {
      if (String(row?.code) === String(code) || String(row?.name) === String(name)) return row
      const child = walk(row?.children)
      if (child) return child
    }
    return null
  }
  return walk(rows)
}

export async function createWarehouseFixture (api, caseRecord, token, index = 1) {
  const code = fixtureCode(token, 'WH', index)
  const name = `E2E-WMS warehouse ${code.slice(-20)}`
  await api.postBusiness('/mes/wmsWareHouse/add', {
    code,
    name,
    mark: `${WMS_FIXTURE_MARK} ${token}`,
    pid: '0',
    isEnabled: true,
    areaEnabled: true,
    locationEnabled: true,
    countInAvailable: true
  })
  const rows = dataOf(await api.getBusiness('/mes/wmsWareHouse/allTree'), '仓库树回读')
  const warehouse = findWarehouse(Array.isArray(rows) ? rows : rows?.list, code, name)
  if (!warehouse?.id) throw new Error(`WMS 专属仓库创建后未回读：${code}`)
  const fixture = remember(caseRecord, { kind: 'warehouse', id: String(warehouse.id), code, token })
  addCheck(caseRecord, `创建并回读第 ${index} 个专属仓库`, true, `id=${warehouse.id}; code=${code}`)

  const areaCode = fixtureCode(token, 'AR', index)
  await api.postBusiness('/mes/wmsHouseArea/add', {
    areaCode,
    areaName: `E2E-WMS area ${index}`,
    houseId: String(warehouse.id),
    isEnabled: true,
    remark: WMS_FIXTURE_MARK
  })
  const areas = rowsOf(await api.getBusiness(
    `/mes/wmsHouseArea/list?pageNo=1&pageSize=100&houseId=${encodeURIComponent(warehouse.id)}`
  ), '库区回读')
  const area = areas.find((row) => String(row.areaCode) === areaCode)
  if (!area?.id) throw new Error(`WMS 专属库区创建后未回读：${areaCode}`)
  remember(caseRecord, { kind: 'area', id: String(area.id), code: areaCode, warehouseId: String(warehouse.id), token })

  const locationCode = fixtureCode(token, 'LC', index)
  const locationId = dataOf(await api.postBusiness('/mes/wms-house-location/create', {
    locationName: `E2E-WMS location ${index}`,
    locationCode,
    houseId: String(warehouse.id),
    areaId: String(area.id),
    isEnabled: true,
    locationType: 1,
    remark: WMS_FIXTURE_MARK
  }), '库位创建')
  if (locationId === undefined || locationId === null || String(locationId).trim() === '') {
    throw new Error(`WMS 专属库位创建未返回 ID：${locationCode}`)
  }
  remember(caseRecord, { kind: 'location', id: String(locationId), code: locationCode,
    warehouseId: String(warehouse.id), areaId: String(area.id), token })
  return { warehouse: { ...warehouse, id: String(warehouse.id) }, area: { ...area, id: String(area.id) },
    location: { id: String(locationId), locationCode }, token }
}

export async function createMaterialFixture (api, caseRecord, token, unitId) {
  const code = fixtureCode(token, 'MT', 1)
  const id = dataOf(await api.postBusiness('/mes/basMaterial/add', {
    code,
    name: 'E2E-WMS material',
    auxName: 'E2E-WMS material',
    unitId: String(unitId),
    inventoryNature: 'STOCK',
    isMaterial: 'Y',
    isEnabled: 1,
    purchased: 'Y',
    saled: 'Y',
    produced: 'N',
    source: 'purchase',
    leadTime: 1,
    bufferTime: 1,
    batchManaged: 'Y',
    oneBarcode: 'N',
    periodManaged: 'N',
    gradeManaged: 'N',
    remark: WMS_FIXTURE_MARK
  }), '物料创建')
  if (id === undefined || id === null || String(id).trim() === '') throw new Error('WMS 专属物料未返回 ID')
  const material = dataOf(await api.getBusiness(`/mes/basMaterial/queryById?id=${encodeURIComponent(id)}`), '物料回读')
  if (String(material?.code) !== code || String(material?.remark) !== WMS_FIXTURE_MARK) {
    throw new Error(`WMS 专属物料所有权回读失败：${id}`)
  }
  remember(caseRecord, { kind: 'material', id: String(id), code, token })
  addCheck(caseRecord, '创建并回读专属实物物料', true, `id=${id}; code=${code}`)
  return material
}

async function ensureQualityMaterialFixture (api, caseRecord, material, stockIoType) {
  const plans = rowsOf(await api.getBusiness(
    `/mes/quality/qualityPlan/list/dictText?pageNo=1&pageSize=100&type=${encodeURIComponent(stockIoType)}`
  ), `${stockIoType} 质检方案回读`)
  const plan = plans.find((row) => row?.id)
  if (!plan?.id) throw new Error(`WMS ${stockIoType} 质检入库缺少可复用质检方案`)
  await api.postBusiness('/mes/quality/qualityMaterial/addBatch', [{
    materialId: String(material.id),
    planId: String(plan.id),
    type: String(stockIoType),
    effectiveFrom: new Date().toISOString().slice(0, 10),
    isDefault: true,
    priority: 999
  }])
  const rules = rowsOf(await api.getBusiness(
    `/mes/quality/qualityMaterial/list/dictText?pageNo=1&pageSize=100&types=${encodeURIComponent(stockIoType)}&materialId=${encodeURIComponent(material.id)}`
  ), `${stockIoType} 质检存货回读`)
  const rule = rules.find((row) => String(row?.materialId) === String(material.id) && String(row?.type) === String(stockIoType))
  if (!rule?.id) throw new Error(`WMS ${stockIoType} 质检存货创建后未回读：${material.id}`)
  remember(caseRecord, { kind: 'qualityMaterial', id: String(rule.id), materialId: String(material.id), type: String(stockIoType), token: material.code })
  addCheck(caseRecord, `${stockIoType} 质检存货规则创建并回读`, true, `material=${material.id}; plan=${plan.id}`)
  return rule
}

export async function createOpeningInventory (api, caseRecord, fixture, material, unitId, quantity = 106) {
  const batchNo = `${fixture.token}-OPENING-BATCH`
  const body = {
    billNo: fixtureCode(fixture.token, 'IO', 106),
    billDate: new Date().toISOString().slice(0, 10),
    subject: `${fixture.token} opening inventory`,
    remark: `${WMS_FIXTURE_MARK} ${fixture.token}`,
    stockIoType: '106',
    isAuto: 0,
    stkIoEntryList: [{
      materialId: String(material.id),
      unitId: String(unitId),
      qty: quantity,
      cost: 1,
      warehouseId: fixture.warehouse.id,
      wareAreaId: fixture.area.id,
      wareLocationId: fixture.location.id,
      batchNo,
      entryNo: 1,
      stockIoType: '106',
      stockIoDirection: '1',
      isQc: 0,
      settleQty: quantity
    }],
    stkIoDistributionList: [],
    stkIoBomList: []
  }
  const id = dataOf(await api.postBusiness('/mes/stkIo/add/submit', body), '106 期初正式提交')
  if (id === undefined || id === null || String(id).trim() === '') throw new Error('106 期初提交未返回 ID')
  let detail = dataOf(await api.getBusiness(`/mes/stkIo/queryById?id=${encodeURIComponent(id)}`), '106 期初回读')
  const owned = String(detail?.stockIoType) === '106' && isOwnedFixture(detail, fixture.token)
  addCheck(caseRecord, '106 期初正式提交后回读类型和所有权', owned, `id=${id}; type=${detail?.stockIoType}`)
  const opening = remember(caseRecord, { kind: 'opening', id: String(id), batchNo, quantity, token: fixture.token, status: 'SUBMITTED' })
  let approved = isEffective(detail)
  if (approved) {
    addCheck(caseRecord, '106 期初详情已自动生效且未重复审批', true, `id=${id}; effective=${detail.isEffective}`)
  } else {
    try {
      await api.putBusiness('/mes/stkIo/check', {
        id: String(id), approvalResultType: '1', approvalRemark: `${WMS_FIXTURE_MARK} approve`
      })
    } catch (error) {
      caseRecord.notes.push(`106 期初审批未完成：${error.message}`)
    }
    detail = dataOf(await api.getBusiness(`/mes/stkIo/queryById?id=${encodeURIComponent(id)}`), '106 期初审批后回读')
    approved = isEffective(detail)
  }
  opening.status = approved ? 'EFFECTIVE' : 'SUBMITTED'
  opening.detail = detail
  addCheck(caseRecord, '106 期初以详情 isEffective 判断生效状态', approved, `id=${id}; effective=${detail?.isEffective}`)
  return { ...opening, detail, approved, body }
}

export async function createStockIoFixture (api, caseRecord, fixture, material, unitId, {
  stockIoType = '101', quantity = 10, isQc = 0, batchNo = `${fixture.token}-RECEIPT-BATCH`
} = {}) {
  const body = {
    billNo: fixtureCode(fixture.token, 'IO', stockIoType),
    billDate: new Date().toISOString().slice(0, 10),
    subject: `${fixture.token} stock io ${stockIoType}`,
    remark: `${WMS_FIXTURE_MARK} ${fixture.token}`,
    stockIoType,
    isAuto: 0,
    stkIoEntryList: [{
      materialId: String(material.id), unitId: String(unitId), qty: quantity, cost: 1,
      warehouseId: fixture.warehouse.id, wareAreaId: fixture.area.id,
      wareLocationId: fixture.location.id, batchNo, stockIoType,
      entryNo: 1,
      stockIoDirection: stockIoType === '201' || stockIoType === '299' ? '2' : '1',
      isQc, settleQty: quantity
    }],
    stkIoDistributionList: [], stkIoBomList: []
  }
  if (Number(isQc) === 1) await ensureQualityMaterialFixture(api, caseRecord, material, stockIoType)
  const id = dataOf(await api.postBusiness('/mes/stkIo/add/submit', body), `${stockIoType} 正式提交`)
  let detail = dataOf(await api.getBusiness(`/mes/stkIo/queryById?id=${encodeURIComponent(id)}`), `${stockIoType} 回读`)
  const owned = String(detail?.stockIoType) === stockIoType && isOwnedFixture(detail, fixture.token)
  addCheck(caseRecord, `${stockIoType} 正式提交后回读类型和所有权`, owned, `id=${id}`)
  remember(caseRecord, { kind: 'stockIo', id: String(id), stockIoType, token: fixture.token, status: 'SUBMITTED' })
  let approved = isEffective(detail)
  if (approved) {
    addCheck(caseRecord, `${stockIoType} 详情已自动生效且未重复审批`, true, `id=${id}; effective=${detail.isEffective}`)
  } else {
    try {
      await api.putBusiness('/mes/stkIo/check', {
        id: String(id), approvalResultType: '1', approvalRemark: `${WMS_FIXTURE_MARK} approve`
      })
    } catch (error) {
      caseRecord.notes.push(`${stockIoType} 审批未完成：${error.message}`)
    }
    detail = dataOf(await api.getBusiness(`/mes/stkIo/queryById?id=${encodeURIComponent(id)}`), `${stockIoType} 审批后回读`)
    approved = isEffective(detail)
  }
  addCheck(caseRecord, `${stockIoType} 以详情 isEffective 判断生效状态`, approved, `id=${id}; effective=${detail?.isEffective}`)
  return { id: String(id), detail, approved, body, batchNo, quantity }
}

export async function createTransferFixture (api, caseRecord, fixture, material, unitId, target) {
  const idempotencyKey = `${fixture.token}:TRANSFER:${randomUUID()}`
  const body = {
    idempotencyKey, billDate: new Date().toISOString(), outWarehouseId: fixture.warehouse.id,
    inWarehouseId: target.warehouse.id, remark: `${WMS_FIXTURE_MARK} ${fixture.token}`,
    submitAfterCreate: false,
    lines: [{ materialId: String(material.id), unitId: String(unitId), qty: 10,
      outAreaId: fixture.area.id, outLocationId: fixture.location.id,
      inAreaId: target.area.id, inLocationId: target.location.id,
      outBatchNo: `${fixture.token}-OPENING-BATCH`, inBatchNo: `${fixture.token}-OPENING-BATCH`, cost: 1 }]
  }
  const id = dataOf(await api.postBusiness('/wms/transfer-bill/create', body), '调拨正式创建')
  if (!id) throw new Error('调拨创建未返回 ID')
  const retry = dataOf(await api.postBusiness('/wms/transfer-bill/create', body), '调拨幂等重试')
  addCheck(caseRecord, '调拨同一幂等键返回同一单据', String(retry) === String(id), `first=${id}; retry=${retry}`)
  remember(caseRecord, { kind: 'transfer', id: String(id), idempotencyKey, token: fixture.token, status: 'DRAFT' })
  return { id: String(id), body }
}

export async function createBorrowFixture (api, caseRecord, fixture, material, unitId) {
  const idempotencyKey = `${fixture.token}:BORROW:${randomUUID()}`
  const body = {
    idempotencyKey, billDate: new Date().toISOString(), warehouseId: fixture.warehouse.id,
    borrowerId: '1', borrowerName: 'E2E WMS borrower', purpose: `${WMS_FIXTURE_MARK} ${fixture.token}`,
    expectedReturnDate: new Date(Date.now() + 7 * 86400000).toISOString(), submitAfterCreate: false,
    lines: [{ materialId: String(material.id), unitId: String(unitId), qty: 10,
      areaId: fixture.area.id, locationId: fixture.location.id,
      batchNo: `${fixture.token}-OPENING-BATCH`, cost: 1 }]
  }
  const id = dataOf(await api.postBusiness('/wms/borrow-bill/create', body), '借用正式创建')
  if (!id) throw new Error('借用创建未返回 ID')
  const retry = dataOf(await api.postBusiness('/wms/borrow-bill/create', body), '借用幂等重试')
  addCheck(caseRecord, '借用同一幂等键返回同一单据', String(retry) === String(id), `first=${id}; retry=${retry}`)
  remember(caseRecord, { kind: 'borrow', id: String(id), idempotencyKey, token: fixture.token, status: 'DRAFT' })
  return { id: String(id), body }
}

export const pageRows = (payload) => {
  const data = dataOf(payload, 'WMS 分页')
  if (!data || typeof data !== 'object' ||
    (!Array.isArray(data.list) && !Array.isArray(data.records))) {
    throw new Error('WMS 分页未返回数组')
  }
  return { data, rows: Array.isArray(data.list) ? data.list : data.records }
}

export async function inventorySnapshot (api, fixture, materialId) {
  const query = `/mes/stkInventory/list?pageNo=1&pageSize=100&warehouseId=${encodeURIComponent(fixture.warehouse.id)}` +
    `&wareAreaId=${encodeURIComponent(fixture.area.id)}&wareLocationId=${encodeURIComponent(fixture.location.id)}` +
    `&materialId=${encodeURIComponent(materialId)}`
  return rowsOf(await api.getBusiness(query), 'mes_stk_inventory 专属快照')
}

export async function cleanupWmsFixtures (api, caseRecord) {
  const fixtures = [...(caseRecord.fixtures || [])].reverse()
  for (const fixture of fixtures) {
    try {
      if (fixture.kind === 'opening') {
        const detail = dataOf(await api.getBusiness(`/mes/stkIo/queryById?id=${encodeURIComponent(fixture.id)}`), '清理前期初回读')
        if (Number(detail?.isEffective || 0) === 1) {
          caseRecord.notes.push(`保留已生效 106 期初夹具 ${fixture.id}，不直接删除库存事实`)
          continue
        }
        await api.deleteBusiness(`/mes/stkIo/delete?id=${encodeURIComponent(fixture.id)}`)
      } else if (fixture.kind === 'stockIo') {
        const detail = dataOf(await api.getBusiness(`/mes/stkIo/queryById?id=${encodeURIComponent(fixture.id)}`), '清理前库存单回读')
        if (Number(detail?.isEffective || 0) === 1) {
          caseRecord.notes.push(`保留已生效库存单 ${fixture.id}，不直接删除库存流水`)
          continue
        }
        await api.deleteBusiness(`/mes/stkIo/delete?id=${encodeURIComponent(fixture.id)}`)
      } else if (fixture.kind === 'transfer') {
        const detail = dataOf(await api.getBusiness(`/wms/transfer-bill/get?id=${encodeURIComponent(fixture.id)}`), '清理前调拨回读')
        if (detail?.transferStatus !== 'DRAFT' || Number(detail?.isEffective || 0) === 1) continue
        await api.deleteBusiness(`/wms/transfer-bill/delete?id=${encodeURIComponent(fixture.id)}`)
      } else if (fixture.kind === 'borrow') {
        const detail = dataOf(await api.getBusiness(`/wms/borrow-bill/get?id=${encodeURIComponent(fixture.id)}`), '清理前借用回读')
        if (detail?.borrowStatus !== 'DRAFT' || Number(detail?.isEffective || 0) === 1) continue
        await api.deleteBusiness(`/wms/borrow-bill/delete?id=${encodeURIComponent(fixture.id)}`)
      } else if (fixture.kind === 'material') {
        const detail = dataOf(await api.getBusiness(`/mes/basMaterial/queryById?id=${encodeURIComponent(fixture.id)}`), '清理前物料回读')
        if (String(detail?.code) !== String(fixture.code) || !isOwnedFixture(detail, fixture.token)) continue
        await api.deleteBusiness(`/mes/basMaterial/delete?id=${encodeURIComponent(fixture.id)}`)
      } else if (fixture.kind === 'qualityMaterial') {
        await api.deleteBusiness(`/mes/quality/qualityMaterial/delete?id=${encodeURIComponent(fixture.id)}`)
      } else if (fixture.kind === 'location') {
        await api.deleteBusiness(`/mes/wms-house-location/delete?id=${encodeURIComponent(fixture.id)}`)
      } else if (fixture.kind === 'area') {
        await api.deleteBusiness(`/mes/wmsHouseArea/delete?id=${encodeURIComponent(fixture.id)}`)
      } else if (fixture.kind === 'warehouse') {
        await api.deleteBusiness(`/mes/wmsWareHouse/delete?id=${encodeURIComponent(fixture.id)}`)
      }
    } catch (error) {
      caseRecord.notes.push(`清理残留 ${fixture.kind}=${fixture.id} 失败：${error.message}`)
    }
  }
  caseRecord.notes.push('WMS 夹具清理仅按本轮 token、ID 和所有权执行；未触碰共享账户或共享主数据。')
}

export async function prepareWmsFixture (api, caseRecord, index = 1) {
  assertLocalWmsWriteTarget()
  if (!isWmsWriteEnabled()) throw new Error('BLOCKED: CFOR_E2E_WRITE_FIXTURES=true 未启用')
  const token = fixtureToken(`RUN-${index}`)
  const units = rowsOf(await api.getBusiness('/mes/basUnit/list/enabled'), '启用计量单位')
  const unit = units.find((row) => row?.id)
  if (!unit?.id) throw new Error('BLOCKED: 没有启用计量单位，未创建设备和库存夹具')
  const warehouse = await createWarehouseFixture(api, caseRecord, token, index)
  const material = await createMaterialFixture(api, caseRecord, token, unit.id)
  return { token, unit, material, ...warehouse }
}
