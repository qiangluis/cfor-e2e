import { randomUUID } from 'node:crypto'

import { matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'

const MARK = 'E2E PB032 material validation closure'
const text = (value) => String(value ?? '').trim()
const dataOf = (response) => response?.data

export const materialValidationRejections = Object.freeze({
  stockWithoutUnit: {
    code: 2010100006,
    message: /配置不合法：实物存货必须维护主单位/
  },
  invalidPeriodDays: {
    code: 2010100006,
    message: /配置不合法：启用保质期管理时，保质期天数必须为正整数/
  },
  nonPhysicalWmsStock: {
    code: 500,
    message: /不能用于仓储库存：服务项目和虚拟件禁止进入实物库存/,
    allowServiceCode: true
  }
})

export const materialValidationCheckNames = Object.freeze({
  serviceReadback: 'SERVICE 非实物档案回读并自动清空仓储控制',
  virtualReadback: 'VIRTUAL 非实物档案回读并自动清空仓储控制',
  serviceWmsRejected: 'SERVICE 非实物存货进入 WMS 正式保存被精确拒绝且不生成单据',
  virtualWmsRejected: 'VIRTUAL 非实物存货进入 WMS 正式保存被精确拒绝且不生成单据'
})

const addCheck = (record, name, passed, details) => {
  record.checks = [...(record.checks || []), { name, passed: Boolean(passed), details }]
  return Boolean(passed)
}
const requireCheck = (record, name, passed, details) => {
  if (!addCheck(record, name, passed, details)) throw new Error(`${name}: ${details}`)
}
const exactId = (value, label) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error(`${label}返回不安全数字 ID，必须使用字符串`)
  }
  const id = text(value)
  if (!/^[1-9]\d*$/.test(id)) throw new Error(`${label}未返回合法 ID`)
  return id
}
const rowsOf = (response, label) => {
  if (!isBusinessSuccess(response)) throw new Error(`${label}读取失败`)
  const data = dataOf(response)
  const rows = Array.isArray(data?.records) ? data.records : data?.list
  if (!Array.isArray(rows)) throw new Error(`${label}未返回数组`)
  return rows
}
const codeOf = (marker, suffix) => `${marker}-${suffix}`.slice(0, 64)
const noStorageControl = (row) =>
  text(row?.batchManaged) === 'N' && text(row?.periodManaged) === 'N' &&
  text(row?.periodDays) === '' && text(row?.defaultWare) === '' &&
  text(row?.defaultWareArea) === '' && text(row?.defaultWareLocation) === ''
const ownsMaterial = (row, expected) =>
  exactId(row?.id, '物料详情') === expected.id && text(row?.code) === expected.code &&
  text(row?.name) === expected.code && text(row?.remark) === expected.marker &&
  text(row?.inventoryNature) === expected.inventoryNature && noStorageControl(row)
const materialBody = ({ code, marker, inventoryNature, unitId, periodManaged = 'N', periodDays = null }) => ({
  code,
  name: code,
  auxName: code,
  unitId: unitId == null ? null : String(unitId),
  inventoryNature,
  virtualGoods: inventoryNature === 'VIRTUAL' ? 'Y' : 'N',
  isEnabled: 1,
  source: 'purchase',
  purchased: 'Y',
  saled: 'Y',
  produced: 'N',
  isMaterial: 'N',
  parented: 'N',
  assembled: 'N',
  soned: 'N',
  leadTime: 1,
  bufferTime: 1,
  batchManaged: 'N',
  oneBarcode: 'N',
  periodManaged,
  periodDays,
  gradeManaged: 'N',
  colorManaged: 'N',
  brandManaged: 'N',
  backflush: 'N',
  remark: marker
})

const findMaterialByCode = async (api, code) => rowsOf(
  await api.getBusiness(`/mes/basMaterial/list?pageNo=1&pageSize=100&code=${encodeURIComponent(code)}`),
  '物料分页'
).filter((row) => text(row?.code) === code)
const findBillByNo = async (api, billNo) => rowsOf(
  await api.getBusiness(`/mes/stkIo/list?pageNo=1&pageSize=100&billNo=${encodeURIComponent(billNo)}`),
  '库存单据分页'
).filter((row) => text(row?.billNo) === billNo)
const materialAbsentFromPage = async (api, material) => {
  const rows = await findMaterialByCode(api, material.code)
  return rows.every((row) => text(row?.id) !== material.id && text(row?.code) !== material.code)
}

const stockLocationIds = (location) => ({
  warehouseId: exactId(location?.warehouseId ?? location?.warehouse?.id, '专属仓库'),
  wareAreaId: exactId(location?.wareAreaId ?? location?.area?.id, '专属库区'),
  wareLocationId: exactId(location?.wareLocationId ?? location?.location?.id, '专属库位')
})
const stockDraftBody = (marker, suffix, material, unitId, location) => ({
  billNo: codeOf(marker, suffix),
  billDate: new Date().toISOString().slice(0, 10),
  subject: `${marker} non-physical stock rejection`,
  remark: marker,
  stockIoType: '101',
  isAuto: 0,
  stkIoEntryList: [{
    materialId: material.id,
    unitId: String(unitId),
    qty: 1,
    cost: 1,
    ...location,
    batchNo: `${marker}-BATCH`,
    entryNo: 1,
    stockIoType: '101',
    stockIoDirection: '1',
    isQc: 0,
    settleQty: 1
  }],
  stkIoDistributionList: [],
  stkIoBomList: []
})

/**
 * Removes only non-physical material records created by this helper. A failed
 * ownership or absence check remains a hard error instead of being swallowed.
 */
export async function cleanupMaterialValidationFixtures (api, fixture, caseRecord) {
  const errors = []
  for (const material of [...(fixture?.materials || [])].reverse()) {
    try {
      const detail = dataOf(await api.getBusiness(
        `/mes/basMaterial/queryById?id=${encodeURIComponent(material.id)}`
      ))
      if (!ownsMaterial(detail, material)) throw new Error('物料所有权、档案形态或仓储控制不匹配')
      await api.deleteBusiness(`/mes/basMaterial/delete?id=${encodeURIComponent(material.id)}`)
      const absent = await materialAbsentFromPage(api, material)
      requireCheck(caseRecord, 'PB032 专属非实物存货删除后分页按 ID/编码不可见', absent,
        `id=${material.id}; code=${material.code}; exactPageAbsent=${absent}`)
    } catch (error) {
      errors.push(`${material?.id || material?.code || 'unknown'}: ${error.message}`)
    }
  }
  if (errors.length) throw new Error(`PB032 物料夹具清理失败：${errors.join('；')}`)
}

export async function verifyMaterialValidationClosure ({ api, caseRecord, unit, stockLocation }) {
  const unitId = exactId(unit?.id ?? unit, '既有启用计量单位')
  const marker = `E2E-PB032-${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`
  const fixture = { marker, materials: [] }
  const expectRejectedCreate = async (name, body, contract) => {
    const response = await api.post('/mes/basMaterial/add', body, { expectedBusinessRejection: contract })
    const rows = await findMaterialByCode(api, body.code)
    requireCheck(caseRecord, name,
      matchesExpectedBusinessRejection(response, contract) && rows.length === 0,
      `code=${response?.code}; message=${response?.msg || response?.message || ''}; materialRows=${rows.length}`)
  }
  const createNonPhysical = async (inventoryNature) => {
    const code = codeOf(marker, inventoryNature)
    const id = exactId(dataOf(await api.postBusiness('/mes/basMaterial/add', materialBody({
      code, marker, inventoryNature, unitId, periodManaged: 'Y', periodDays: '30'
    }))), `PB032 专属${inventoryNature}物料`)
    const owned = { id, code, marker, inventoryNature }
    fixture.materials.push(owned)
    const detail = dataOf(await api.getBusiness(`/mes/basMaterial/queryById?id=${encodeURIComponent(id)}`))
    const readbackCheck = inventoryNature === 'SERVICE'
      ? materialValidationCheckNames.serviceReadback
      : materialValidationCheckNames.virtualReadback
    requireCheck(caseRecord, readbackCheck, ownsMaterial(detail, owned),
      `id=${id}; nature=${detail?.inventoryNature}; periodManaged=${detail?.periodManaged}; defaultWare=${detail?.defaultWare || ''}`)
    return owned
  }
  try {
    await expectRejectedCreate('实物存货缺少主单位返回精确领域拒绝且不留残留', materialBody({
      code: codeOf(marker, 'NO-UNIT'), marker, inventoryNature: 'STOCK', unitId: null
    }), materialValidationRejections.stockWithoutUnit)
    await expectRejectedCreate('启用保质期管理但天数非正整数返回精确领域拒绝且不留残留', materialBody({
      code: codeOf(marker, 'BAD-PERIOD'), marker, inventoryNature: 'STOCK', unitId,
      periodManaged: 'Y', periodDays: '0'
    }), materialValidationRejections.invalidPeriodDays)

    const location = stockLocationIds(stockLocation)
    const [service, virtual] = await Promise.all([
      createNonPhysical('SERVICE'), createNonPhysical('VIRTUAL')
    ])
    for (const material of [service, virtual]) {
      const body = stockDraftBody(marker, `WMS-${material.inventoryNature}`, material, unitId, location)
      const response = await api.post('/mes/stkIo/add/save', body, {
        expectedBusinessRejection: materialValidationRejections.nonPhysicalWmsStock
      })
      const bills = await findBillByNo(api, body.billNo)
      const rejectedCheck = material.inventoryNature === 'SERVICE'
        ? materialValidationCheckNames.serviceWmsRejected
        : materialValidationCheckNames.virtualWmsRejected
      requireCheck(caseRecord, rejectedCheck,
        matchesExpectedBusinessRejection(response, materialValidationRejections.nonPhysicalWmsStock) && bills.length === 0,
        `code=${response?.code}; message=${response?.msg || response?.message || ''}; billNo=${body.billNo}; billRows=${bills.length}`)
    }
    return fixture
  } finally {
    await cleanupMaterialValidationFixtures(api, fixture, caseRecord)
  }
}

export const __internal = {
  materialBody,
  ownsMaterial,
  noStorageControl,
  stockDraftBody,
  stockLocationIds,
  materialAbsentFromPage
}
