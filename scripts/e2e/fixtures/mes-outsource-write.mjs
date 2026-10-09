import { randomBytes } from 'node:crypto'
import { config } from '../config/index.mjs'
import { asList } from '../lib/assertions.mjs'

/**
 * 委外写侧专用夹具。
 *
 * 该模块只创建带 `E2E-OUTSRC` 前缀的专属业务数据，并增量补齐委外写侧
 * 真正缺失的审批前置（mes_bas_bill_options[MesProdOutsource]）。它不做
 * 任何破坏性操作：审批配置仅在缺失时新增，不覆盖其它单据类型或审批策略。
 */

export const OUTSOURCE_MARKER_PREFIX = 'E2E-OUTSRC'
export const OUTSOURCE_APPROVAL_BILL_TYPE = 'MesProdOutsource'
/** 委外单据审核/下达依赖的手工核批类型。 */
export const OUTSOURCE_MANUAL_APPROVAL = '1'
/** 加工费必须挂在服务类存货上，审核前置会强校验 inventoryNature=SERVICE。 */
export const SERVICE_INVENTORY_NATURE = 'SERVICE'

const payloadData = (payload) => payload?.data ?? payload

const listData = (payload) => {
  const data = payloadData(payload)
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.records)) return data.records
  if (Array.isArray(data?.list)) return data.list
  throw new Error('委外专属前置接口未返回数组')
}

export const isStableOutsourceId = (value) => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0
  return typeof value === 'string' && /^[1-9]\d*$/.test(value)
}

const requiredId = (value, label) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error(`${label}返回了不安全的数字ID`)
  }
  const id = String(value ?? '')
  if (!isStableOutsourceId(typeof value === 'number' ? value : id)) {
    throw new Error(`${label}未返回合法ID`)
  }
  return id
}

const markerCode = (marker, suffix) => `${marker}-${suffix}`

const productionTime = (time) => {
  const date = new Date(time)
  if (!Number.isFinite(date.getTime())) throw new Error('生产日期时间无效')
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).format(date)
}

const productionDate = (time) => productionTime(time).slice(0, 10)

const readOwned = (row, marker, label) => {
  if (!row || ![row.code, row.name, row.mark, row.remark, row.billNo, row.prodNo]
    .filter((value) => value !== undefined && value !== null)
    .some((value) => String(value).includes(marker))) {
    throw new Error(`${label}所有权回读失败：marker=${marker}`)
  }
  return row
}

const registerResource = (registry, resource) => {
  const id = requiredId(resource?.id, `专属${resource?.kind || '资源'}`)
  const owned = {
    ...resource,
    id,
    marker: registry.marker,
    cleanup: resource.cleanup || 'RETAINED_AUDIT_PENDING_CLEANUP'
  }
  registry.resources.push(owned)
  registry.onResource?.(owned)
  return owned
}

export const registerOutsourceFixtureResources = (caseRecord, fixture) => {
  if (!caseRecord || !fixture?.resources?.length) return []
  caseRecord.fixtures ||= []
  for (const resource of fixture.resources) {
    const duplicate = caseRecord.fixtures.some((row) =>
      row?.source === 'mes-outsource-write' &&
      row.kind === resource.kind && String(row.id) === String(resource.id))
    if (!duplicate) {
      caseRecord.fixtures.push({ source: 'mes-outsource-write', ...resource })
    }
  }
  return fixture.resources
}

const createDedicatedWarehouse = async (api, marker, registry) => {
  const code = markerCode(marker, 'WH')
  const name = `${marker}-委外仓`
  await api.postBusiness('/mes/wmsWareHouse/add', {
    code, name, mark: marker, pid: '0', isEnabled: true,
    areaEnabled: true, locationEnabled: true, countInAvailable: true
  })
  const tree = payloadData(await api.getBusiness('/mes/wmsWareHouse/allTree'))
  const rows = Array.isArray(tree) ? tree : tree?.list
  const flatten = (nodes) => (nodes || []).flatMap((row) => [row, ...flatten(row?.children)])
  const warehouse = flatten(rows)
    .find((row) => String(row?.name) === name)
  const warehouseId = requiredId(warehouse?.id, '专属委外仓')
  registerResource(registry, { kind: 'warehouse', id: warehouseId, identity: code, name })
  const warehouseDetail = payloadData(await api.getBusiness(
    `/mes/wmsWareHouse/queryById?id=${encodeURIComponent(warehouseId)}`
  ))
  readOwned(warehouseDetail, marker, '专属委外仓')
  if (String(warehouseDetail?.id) !== warehouseId ||
      String(warehouseDetail?.code) !== code || String(warehouseDetail?.name) !== name) {
    throw new Error(`专属委外仓字段回读失败：${warehouseId}`)
  }

  const areaCode = markerCode(marker, 'AR')
  await api.postBusiness('/mes/wmsHouseArea/add', {
    areaCode,
    areaName: `${marker}-委外库区`,
    houseId: warehouseId,
    isEnabled: true,
    remark: marker
  })
  const areas = listData(await api.getBusiness(
    `/mes/wmsHouseArea/list?pageNo=1&pageSize=100&houseId=${encodeURIComponent(warehouseId)}`
  ))
  const area = areas.find((row) => String(row?.areaCode) === areaCode &&
    String(row?.houseId) === warehouseId && String(row?.remark || '').includes(marker))
  const areaId = requiredId(area?.id, '专属委外库区')
  registerResource(registry, {
    kind: 'area', id: areaId, identity: areaCode, warehouseId,
    areaName: area.areaName
  })

  const locationCode = markerCode(marker, 'LC')
  const locationId = requiredId(payloadData(await api.postBusiness(
    '/mes/wms-house-location/create', {
      locationName: `${marker}-委外库位`,
      locationCode,
      houseId: warehouseId,
      areaId,
      isEnabled: true,
      locationType: 1,
      remark: marker
    }
  )), '专属委外库位')
  registerResource(registry, {
    kind: 'location', id: locationId, identity: locationCode,
    warehouseId, areaId
  })
  const location = payloadData(await api.getBusiness(
    `/mes/wms-house-location/get?id=${encodeURIComponent(locationId)}`
  ))
  if (String(location?.id) !== locationId ||
      String(location?.locationCode) !== locationCode ||
      String(location?.houseId) !== warehouseId || String(location?.areaId) !== areaId ||
      String(location?.remark || '').includes(marker) === false) {
    throw new Error(`专属委外库位归属回读失败：${locationId}`)
  }

  return {
    warehouse: { id: warehouseId, code, name },
    area: { id: areaId, code: areaCode, name: area.areaName },
    location: { id: locationId, code: locationCode, name: location.locationName }
  }
}

const createDedicatedMaterial = async (api, marker, unitId, suffix, {
  produced = 'Y', purchased = 'Y', parented = 'Y', isMaterial = 'N'
} = {}, registry) => {
  const code = markerCode(marker, suffix)
  const id = requiredId(payloadData(await api.postBusiness('/mes/basMaterial/add', {
    code,
    name: code,
    auxName: code,
    unitId,
    inventoryNature: 'STOCK',
    isMaterial,
    isEnabled: 1,
    purchased,
    saled: 'Y',
    produced,
    parented,
    source: purchased === 'Y' && produced === 'Y'
      ? 'mixed' : produced === 'Y' ? 'manufacture' : 'purchase',
    leadTime: 1,
    bufferTime: 1,
    refCost: 10,
    refPrice: 20,
    batchManaged: 'N',
    oneBarcode: 'N',
    periodManaged: 'N',
    gradeManaged: 'N',
    colorManaged: 'N',
    brandManaged: 'N',
    backflush: 'N',
    remark: marker
  })), `专属${suffix}物料`)
  registerResource(registry, { kind: 'material', id, identity: code })
  const material = payloadData(await api.getBusiness(
    `/mes/basMaterial/queryById?id=${encodeURIComponent(id)}`
  ))
  if (String(material?.id) !== id || String(material?.code) !== code ||
      String(material?.remark || '').includes(marker) === false) {
    throw new Error(`专属${suffix}物料归属回读失败：${id}`)
  }
  return { id, code, detail: material }
}

export const buildDedicatedBomPayload = ({
  marker, productId, componentId, unitId, warehouseId, areaId
}) => ({
  code: markerCode(marker, 'BOM'),
  stockId: String(productId),
  stockCount: 1,
  version: '1',
  versionDesc: marker,
  defaultRecord: 'N',
  bomUsage: 'PRODUCTION',
  unitId: String(unitId),
  prepayWareHouseId: String(warehouseId),
  prepayWareAreaId: String(areaId),
  mark: marker,
  wmsAssembleSubList: [{
    stockId: String(componentId),
    subStockCount: 1,
    unitId: String(unitId),
    lossRate: 0,
    prepayWareHouseId: String(warehouseId),
    prepayWareAreaId: String(areaId),
    mark: marker
  }]
})

export const buildDedicatedProductionOrderPayload = ({
  marker, productId, componentId, unitId, bomId, startDate, endDate
}) => ({
  prodNo: markerCode(marker, 'PLAN'),
  billNo: markerCode(marker, 'PLAN'),
  prodType: '1',
  remark: marker,
  expectStartDate: startDate,
  expectEndDate: endDate,
  prodOrderSubList: [{
    materialId: String(productId),
    qty: 2,
    wmsAssembleId: String(bomId),
    remark: marker,
    urgentLevel: '1'
  }],
  prodOrderMaterialList: [{
    materialId: String(componentId),
    unitId: String(unitId),
    bomNum: 1,
    quantity: 2,
    claimed: 0,
    requested: 0,
    afterSaveClaimed: 0,
    afterSaveRequested: 0,
    remark: marker
  }]
})

const createDedicatedOpeningInventory = async (api, marker, storage, component, unitId, registry) => {
  // Outsource material-out drafts use the legacy unbatched dimension "0".
  const batchNo = '0'
  const body = {
    billNo: markerCode(marker, 'IO106'),
    billDate: productionDate(Date.now()),
    subject: `${marker} opening inventory`,
    remark: marker,
    stockIoType: '106',
    isAuto: 0,
    stkIoEntryList: [{
      materialId: component.id,
      unitId,
      qty: 4,
      cost: 1,
      warehouseId: storage.warehouse.id,
      wareAreaId: storage.area.id,
      wareLocationId: storage.location.id,
      batchNo,
      entryNo: 1,
      stockIoType: '106',
      stockIoDirection: '1',
      isQc: 0,
      settleQty: 4
    }],
    stkIoDistributionList: [],
    stkIoBomList: []
  }
  const openingId = requiredId(payloadData(await api.postBusiness(
    '/mes/stkIo/add/submit', body
  )), '专属106期初库存')
  const openingResource = registerResource(registry, {
    kind: 'opening', id: openingId, identity: body.billNo,
    stockIoType: '106', batchNo, warehouseId: storage.warehouse.id,
    areaId: storage.area.id, locationId: storage.location.id,
    materialId: component.id
  })
  let detail = payloadData(await api.getBusiness(
    `/mes/stkIo/queryById?id=${encodeURIComponent(openingId)}`
  ))
  const ownedOpening = String(detail?.id) === openingId &&
    String(detail?.stockIoType) === '106' && String(detail?.remark || '').includes(marker)
  if (!ownedOpening) throw new Error(`专属106期初库存归属回读失败：${openingId}`)
  if (Number(detail?.isEffective || 0) !== 1) {
    await api.putBusiness('/mes/stkIo/check', {
      id: openingId,
      approvalResultType: '1',
      approvalRemark: `${marker} opening`
    })
    detail = payloadData(await api.getBusiness(
      `/mes/stkIo/queryById?id=${encodeURIComponent(openingId)}`
    ))
  }
  if (Number(detail?.isEffective || 0) !== 1) {
    throw new Error(`专属106期初库存未正式生效：${openingId}`)
  }

  const inventoryRows = listData(await api.getBusiness(
    `/mes/stkInventory/list/dictText?pageNo=1&pageSize=100` +
    `&warehouseId=${encodeURIComponent(storage.warehouse.id)}` +
    `&wareAreaId=${encodeURIComponent(storage.area.id)}` +
    `&wareLocationId=${encodeURIComponent(storage.location.id)}` +
    `&materialId=${encodeURIComponent(component.id)}` +
    `&batchNo=${encodeURIComponent(batchNo)}`
  ))
  const ownedInventory = inventoryRows.filter((row) =>
    String(row?.warehouseId) === storage.warehouse.id &&
    String(row?.wareAreaId) === storage.area.id &&
    String(row?.wareLocationId) === storage.location.id &&
    String(row?.materialId) === component.id && String(row?.batchNo) === batchNo)
  if (ownedInventory.length !== 1) {
    throw new Error(`专属106期初库存事实未唯一回读：${openingId}; rows=${ownedInventory.length}`)
  }
  const inventory = ownedInventory[0]
  const inventoryId = requiredId(inventory.id, '专属106库存事实')
  registerResource(registry, {
    kind: 'inventory', id: inventoryId, identity: batchNo,
    warehouseId: storage.warehouse.id, areaId: storage.area.id,
    locationId: storage.location.id, materialId: component.id,
    quantity: inventory.qty
  })
  const availableQty = inventory.availableQty ?? inventory.available_qty
  if (!(Number(inventory.qty) > 0) || availableQty === undefined || availableQty === null ||
      !Number.isFinite(Number(availableQty)) || Number(availableQty) <= 0) {
    throw new Error(`专属106库存事实数量不可用于发料：${inventoryId}`)
  }
  openingResource.status = 'EFFECTIVE_RETAINED_AUDIT'
  return { id: openingId, body, detail, inventory, batchNo }
}

const createDedicatedProductionPrerequisite = async (api, marker, { caseRecord } = {}) => {
  const registry = {
    marker,
    resources: [],
    onResource: (resource) => registerOutsourceFixtureResources(caseRecord, { resources: [resource] })
  }
  try {
  const units = listData(await api.getBusiness('/mes/basUnit/list/enabled'))
  const unit = units.find((row) => row?.id)
  const unitId = requiredId(unit?.id, '启用计量单位')
  const storage = await createDedicatedWarehouse(api, marker, registry)
  const product = await createDedicatedMaterial(api, marker, unitId, 'FG', {
    produced: 'Y', purchased: 'N', parented: 'Y', isMaterial: 'N'
  }, registry)
  const component = await createDedicatedMaterial(api, marker, unitId, 'RM', {
    produced: 'N', purchased: 'Y', parented: 'N', isMaterial: 'Y'
  }, registry)
  const bomCode = markerCode(marker, 'BOM')
  const bomBody = buildDedicatedBomPayload({
    marker,
    productId: product.id,
    componentId: component.id,
    unitId,
    warehouseId: storage.warehouse.id,
    areaId: storage.area.id
  })
  const bomId = requiredId(payloadData(await api.postBusiness('/mes/wmsAssemble/add', bomBody)), '专属生产 BOM')
  registerResource(registry, { kind: 'bom', id: bomId, identity: bomBody.code })
  const bom = payloadData(await api.getBusiness(`/mes/wmsAssemble/queryById?id=${bomId}`))
  const bomSubs = listData(await api.getBusiness(
    `/mes/wmsAssemble/queryWmsAssembleSubByMainId?id=${bomId}&pageNo=1&pageSize=100`
  ))
  if (String(bom?.id) !== bomId || String(bom?.stockId) !== product.id ||
      bom?.bomUsage !== 'PRODUCTION' || String(bom?.prepayWareHouseId) !== storage.warehouse.id ||
      String(bom?.prepayWareAreaId) !== storage.area.id ||
      bomSubs.length !== 1 || String(bomSubs[0]?.stockId) !== component.id ||
      String(bomSubs[0]?.prepayWareHouseId) !== storage.warehouse.id ||
      String(bomSubs[0]?.prepayWareAreaId) !== storage.area.id) {
    throw new Error(`专属生产 BOM 或子件仓储归属回读失败：bomId=${bomId}`)
  }
  const opening = await createDedicatedOpeningInventory(
    api, marker, storage, component, unitId, registry
  )

  const prodNo = markerCode(marker, 'PLAN')
  const startDate = productionTime(Date.now() + 3600000)
  const endDate = productionTime(Date.now() + 5 * 3600000)
  const orderBody = buildDedicatedProductionOrderPayload({
    marker,
    productId: product.id,
    componentId: component.id,
    unitId,
    bomId,
    startDate,
    endDate
  })
  const orderId = requiredId(payloadData(await api.postBusiness('/mes/prodOrder/add', orderBody)), '专属生产订单')
  registerResource(registry, { kind: 'order', id: orderId, identity: prodNo })
  const order = payloadData(await api.getBusiness(`/mes/prodOrder/queryById?id=${orderId}`))
  const orderSubs = listData(await api.getBusiness(
    `/mes/prodOrder/queryMesProdOrderSubByMainId?id=${orderId}`
  ))
  if (String(order?.id) !== orderId ||
      String(order?.prodNo || order?.billNo) !== prodNo || String(order?.remark) !== marker ||
      orderSubs.length !== 1 || String(orderSubs[0]?.materialId) !== product.id ||
      String(orderSubs[0]?.wmsAssembleId) !== bomId) {
    throw new Error(`专属生产订单归属回读失败：orderId=${orderId}`)
  }

  await api.putBusiness('/mes/prodOrder/check', {
    id: orderId,
    approvalResultType: '1',
    approvalRemark: marker
  })
  await api.postBusiness('/mes/prodWork/transferWorkOrder', [{
    prodOrderId: orderId,
    prodOrderSubId: requiredId(orderSubs[0]?.id, '生产订单子表'),
    qty: 2,
    prodType: '1',
    operateType: 1,
    batchNo: markerCode(marker, 'B1')
  }])
  const works = listData(await api.getBusiness(
    `/mes/prodWork/getWorkByProdOrderId?prodOrderId=${encodeURIComponent(orderId)}`
  ))
  if (works.length !== 1 || String(works[0]?.prodOrderId) !== orderId ||
      String(works[0]?.remark) !== marker) {
    throw new Error(`专属生产订单转工单归属回读失败：orderId=${orderId}`)
  }
  const workId = requiredId(works[0]?.id, '专属生产工单')
  registerResource(registry, { kind: 'work', id: workId, identity: markerCode(marker, 'B1') })
  const work = payloadData(await api.getBusiness(`/mes/prodWork/queryById?id=${workId}`))
  const workSubs = listData(await api.getBusiness(
    `/mes/prodWorkSub/queryEntryByMainId?id=${workId}`
  ))
  const workSubSummary = workSubs.find((row) => String(row?.materialId) === component.id)
  // The entry-list VO omits prepayment storage fields; the public DO detail retains them.
  const workSub = workSubSummary?.id
    ? payloadData(await api.getBusiness(
      `/mes/prodWorkSub/queryById?id=${requiredId(workSubSummary.id, '专属工单子件')}`
    ))
    : null
  if (String(work?.id) !== String(works[0].id) ||
      String(work?.prodOrderId) !== orderId ||
      !workSub || String(workSub.mid) !== workId ||
      String(workSub.materialId) !== component.id ||
      String(workSub.prepayWareHouseId) !== storage.warehouse.id ||
      String(workSub.prepayWareAreaId) !== storage.area.id) {
    throw new Error(`专属工单子件预出库仓储回读失败：workId=${workId}`)
  }
  registry.status = 'READY_RETAINED_AUDIT'
  return {
    marker,
    unitId,
    storage,
    product,
    component,
    opening,
    bom: { id: bomId, code: bomCode, detail: bom, sub: bomSubs[0] },
    order: { id: orderId, prodNo, detail: order, sub: orderSubs[0] },
    work: { id: workId, detail: work, sub: workSub },
    resources: registry.resources,
    cleanup: registry.status
  }
  } catch (error) {
    registry.status = 'RETAINED_AUDIT_FAILURE'
    for (const resource of registry.resources) {
      resource.cleanup = registry.status
      const recordResource = caseRecord?.fixtures?.find((row) =>
        row?.source === 'mes-outsource-write' && row.kind === resource.kind &&
        String(row.id) === String(resource.id))
      if (recordResource) Object.assign(recordResource, resource)
    }
    error.fixtureResources = registry.resources
    error.fixtureMarker = marker
    throw error
  }
}

export function newOutsourceMarker () {
  return `${OUTSOURCE_MARKER_PREFIX}-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`
}

export function assertOutsourceFixtureScope (settings = config) {
  if (settings.target !== 'local' || String(settings.tenantId) !== '1' ||
      settings.tenantName !== 'CFOR 标准平台' || settings.db?.name !== 'cfor_admin_standard') {
    throw new Error('BLOCKED: 委外写侧夹具仅允许本机 tenant1/CFOR 标准平台/cfor_admin_standard')
  }
  for (const [base, port] of [[settings.apiBase, '48083'], [settings.webBase, '9151']]) {
    const url = new URL(base)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.port !== port || url.username || url.password) {
      throw new Error('BLOCKED: 委外写侧夹具仅允许本机 48083/9151')
    }
  }
}

/** 加工费服务类存货：唯一编码，避免复用历史污染数据。 */
export async function ensureServiceMaterial (api, marker = newOutsourceMarker()) {
  const code = `${marker}-FEE`
  const existing = asList(payloadData(
    await api.getBusiness(`/mes/basMaterial/list/dictText?pageNo=1&pageSize=100&code=${encodeURIComponent(code)}`)
  )).find((row) => String(row.code) === code)
  if (existing?.id) return { id: requiredId(existing.id, '已有服务类存货'), code, created: false }
  const created = payloadData(await api.postBusiness('/mes/basMaterial/add', {
    code, name: code, remark: marker, inventoryNature: SERVICE_INVENTORY_NATURE,
    isEnabled: 1, virtualGoods: 'N', source: 'mixed',
    purchased: 'N', saled: 'N', produced: 'N', parented: 'N',
    isMaterial: 'N', assembled: 'N', soned: 'N',
    batchManaged: 'N', oneBarcode: 'N', periodManaged: 'N', gradeManaged: 'N',
    colorManaged: 'N', brandManaged: 'N', backflush: 'N',
    leadTime: 1, bufferTime: 1, refPrice: 0, refCost: 0
  }))
  return { id: requiredId(created, '专属服务类存货'), code, created: true }
}

/**
 * 增量补齐委外审批配置。
 *
 * 标准租户默认没有 mes_bas_bill_options[MesProdOutsource]，BillUtils.getApprovalType
 * 回退为 "0"（免审），导致 Bill.getActions() 不提供 check，审核直接报
 * “单据不能做该操作”。该接口为租户级增量写入，不覆盖其它单据类型与审批策略。
 */
export async function ensureOutsourceApprovalOption (api) {
  const page = await api.getBusiness(
    `/mes/basBillOptions/list?pageNo=1&pageSize=100&billType=${OUTSOURCE_APPROVAL_BILL_TYPE}`
  )
  const rows = asList(payloadData(page))
  const match = rows.find((row) =>
    String(row.billType) === OUTSOURCE_APPROVAL_BILL_TYPE &&
    String(row.mbillApprovalType) === OUTSOURCE_MANUAL_APPROVAL
  )
  if (match?.id) return { created: false, id: String(match.id) }
  const created = await api.postBusiness('/mes/basBillOptions/add', {
    billType: OUTSOURCE_APPROVAL_BILL_TYPE,
    mbillApprovalType: OUTSOURCE_MANUAL_APPROVAL,
    abillApprovalType: OUTSOURCE_MANUAL_APPROVAL
  })
  return { created: true, response: created }
}

/**
 * 委外 110 收货必须先生成 104 质检事实，再由质检结果驱动入库执行。
 * 仅在本地验收租户缺少该单据策略时增量补齐，不覆盖已有租户配置。
 */
export async function ensureOutsourceReceiptApprovalOption (api) {
  const billType = 'MesStkIo:110'
  const page = await api.getBusiness(
    `/mes/basBillOptions/list?pageNo=1&pageSize=100&billType=${encodeURIComponent(billType)}`
  )
  const rows = asList(payloadData(page))
  const match = rows.find((row) =>
    String(row.billType) === billType &&
    String(row.mbillApprovalType) === OUTSOURCE_MANUAL_APPROVAL &&
    Number(row.isAutoExecute || 0) === 0
  )
  if (match?.id) return { created: false, id: String(match.id), billType }
  const created = await api.postBusiness('/mes/basBillOptions/add', {
    billType,
    mbillApprovalType: OUTSOURCE_MANUAL_APPROVAL,
    abillApprovalType: OUTSOURCE_MANUAL_APPROVAL,
    isAutoExecute: 0,
    isAutoEndExecute: 0,
    isAutoClose: 0
  })
  return { created: true, response: created, billType }
}

/** 创建带专属单号的委外草稿单，返回真实单据 id 与用于断言的快照。 */
export async function createOutsourceDraft (api, {
  marker = newOutsourceMarker(),
  caseRecord,
  dedicatedPrerequisite = false,
  prodWorkId,
  materialId,
  unitId,
  supplierId,
  processFeeMaterialId,
  planQty = 2,
  processPrice = 7,
  materialAmount = 3,
  giftLossQty = 0.5,
  taxInclusive = 1,
  currencyCode = 'CNY',
  taxRate = 13
} = {}) {
  // Lightweight cases may intentionally use a caller-owned read-only work. Heavy
  // material-out cases must opt into the complete dedicated production chain.
  const prerequisite = dedicatedPrerequisite
    ? await createDedicatedProductionPrerequisite(api, marker, { caseRecord })
    : null
  const dedicatedWorkId = prerequisite?.work.id ?? requiredId(prodWorkId, '委外生产工单')
  const dedicatedMaterialId = prerequisite?.product.id ?? requiredId(materialId, '委外成品物料')
  const dedicatedUnitId = prerequisite?.unitId ?? requiredId(unitId, '委外计量单位')
  const billNo = `${marker}-WO`
  const items = [{
    entryNo: 1,
    prodWorkId: dedicatedWorkId,
    materialId: dedicatedMaterialId,
    unitId: dedicatedUnitId,
    supplierId,
    processFeeMaterialId,
    planQty,
    processPrice
  }]
  const body = {
    billNo,
    subject: marker,
    sourceType: 'WORK',
    outsourceType: 'WORK',
    outsourceTypeCode: 'OUTSOURCE_WORK',
    outsourceTypeRuleVersion: 1,
    prodWorkId: dedicatedWorkId,
    materialId: dedicatedMaterialId,
    unitId: dedicatedUnitId,
    supplierId,
    processFeeMaterialId,
    planQty,
    processPrice,
    materialAmount,
    giftLossQty,
    taxInclusive,
    currencyCode,
    taxRate,
    isAuto: 0,
    isRubric: 0,
    status: 0,
    items
  }
  const id = requiredId(payloadData(await api.postBusiness('/mes/prodOutsource/add', body)), '委外草稿')
  const resources = prerequisite?.resources ? [...prerequisite.resources] : []
  const draftResource = {
    source: 'mes-outsource-write', kind: 'outsource', id, identity: billNo,
    marker, cleanup: 'RETAINED_AUDIT_PENDING_CLEANUP'
  }
  resources.push(draftResource)
  registerOutsourceFixtureResources(caseRecord, { resources: [draftResource] })
  return { id, billNo, marker, prerequisite, resources, body }
}

/** 提交审批 -> 审核 -> 下达，逐步返回每一步的真实响应，供断言与留证。 */
export async function driveOutsourceLifecycle (api, id, remark = 'E2E 委外写侧闭环') {
  const steps = {}
  steps.submitApproval = await api.putBusiness(`/mes/prodOutsource/submitApproval?id=${encodeURIComponent(id)}`)
  steps.check = await api.putBusiness(`/mes/prodOutsource/check?id=${encodeURIComponent(id)}`)
  steps.release = await api.putBusiness(
    `/mes/prodOutsource/release?id=${encodeURIComponent(id)}&remark=${encodeURIComponent(remark)}`
  )
  return steps
}

export async function queryOutsourceDetail (api, id) {
  return payloadData(await api.getBusiness(`/mes/prodOutsource/queryById?id=${encodeURIComponent(id)}`))
}

export async function queryOutsourceActionLogs (api, id) {
  return asList(payloadData(await api.getBusiness(`/mes/prodOutsource/queryActionLogs?id=${encodeURIComponent(id)}`)))
}

export async function queryPriceAdjustments (api, id) {
  return asList(payloadData(await api.getBusiness(`/mes/prodOutsource/queryPriceAdjustments?id=${encodeURIComponent(id)}`)))
}
