export const cases = [
  'WMS-QC-001',
  'WMS-QC-002',
  'WMS-QC-003',
  'WMS-QC-004',
  'WMS-QC-005',
  'WMS-QC-006',
  'WMS-QC-007',
  'WMS-QC-008',
  'WMS-QC-009',
  'WMS-QC-010'
]

import fs from 'node:fs'
import {
  createApiClient as apiClient,
  isBusinessRejection,
  matchesExpectedBusinessRejection
} from '../lib/api.mjs'
import { isBusinessSuccess } from '../lib/assertions.mjs'
import { login as browserLogin, openRoute as browserOpenRoute, saveScreenshot as browserScreenshot } from '../lib/browser.mjs'
import {
  WMS_FIXTURE_MARK,
  createOpeningInventory,
  createMaterialFixture,
  createStockIoFixture,
  assertLocalWmsWriteTarget,
  dataOf,
  fixtureToken,
  inventorySnapshot,
  isOwnedFixture,
  isWmsWriteEnabled,
  prepareWmsFixture,
  cleanupWmsFixtures,
  rowsOf
} from '../lib/wms-fixtures.mjs'
import { checkInspection, createInspection } from '../fixtures/mes-quality-write.mjs'
import { withManualOqcScenario } from '../fixtures/quality-manual-scenario.mjs'
import { runWmsQcClosure, WMS_QC_CLOSURE_CASES } from '../fixtures/wms-qc-closure.mjs'
import {
  verifyCrossAreaRejection, verifyCrossWarehouseCodes, verifyLocationOccupied, verifyLocationReferenceClosure
} from '../fixtures/wms-location-closure.mjs'
import { verifyWarehouseBrowserPersistence } from '../fixtures/wms-warehouse-browser.mjs'
import { verifyWarehouseDimensionInventory } from '../fixtures/wms-dimension-closure.mjs'
import { verifyWmsTenantIsolation } from '../fixtures/wms-tenant-isolation.mjs'
import { verifyWmsTransportClosure, wmsQc007Mapping } from '../fixtures/wms-transport-closure.mjs'
import { verifyLegacyWarehouse } from '../fixtures/wms-legacy-readonly.mjs'

const wmsCatalogEvidence = (caseId, caseRecord, evidence = {}) => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  const definition = catalog.suites.flatMap((suite) => suite.cases).find((item) => item.id === caseId)
  if (!definition) throw new Error(`缺少原 catalog 案例 ${caseId}`)
  caseRecord.catalogAssertions = (definition.assertions || []).map((assertion, index) => {
    const item = evidence[index] || {}
    const names = Array.isArray(item) ? item : item.checks || []
    const checks = names.map((name) => caseRecord.checks.find((check) => check.name === name))
    const verified = names.length > 0 && checks.every((check) => check?.passed === true)
    return {
      index,
      assertion,
      status: verified ? 'VERIFIED' : 'GAP',
      evidenceChecks: names,
      details: item.details || (verified
        ? checks.map((check) => `${check.name}: ${check.details || ''}`).join('; ')
        : (item.gap || '本轮未形成完整证据'))
    }
  })
  for (const [gapIndex, gap] of (definition.acceptanceGaps || []).entries()) {
    const names = evidence.audit?.[gapIndex] || []
    const checks = names.map((name) => caseRecord.checks.find((check) => check.name === name))
    const verified = names.length > 0 && checks.every((check) => check?.passed === true)
    caseRecord.catalogAssertions.push({
      assertion: gap, status: verified ? 'VERIFIED' : 'GAP', evidenceChecks: names,
      details: verified
        ? checks.map((check) => `${check.name}: ${check.details || ''}`).join('; ')
        : '审计附加门禁尚未形成独立闭环证据，原断言通过不能抹去该缺口'
    })
  }
  caseRecord.remainingAssertions = caseRecord.catalogAssertions
    .filter((item) => item.status === 'GAP').map((item) => item.assertion)
  caseRecord.passCandidate = caseRecord.remainingAssertions.length === 0 &&
    caseRecord.checks.length > 0 && caseRecord.checks.every((check) => check.passed !== false)
  caseRecord.notes.push(
    `原 catalog 未修改；PASS候选=${caseRecord.passCandidate}；` +
    `剩余=${caseRecord.remainingAssertions.join('；') || '无'}`
  )
  return caseRecord
}

export const strictList = (payload) => {
  const candidates = [
    payload?.data?.list,
    payload?.data?.records,
    payload?.list,
    payload?.records,
    payload?.data
  ]
  const value = candidates.find((item) => Array.isArray(item))
  const valid = value !== undefined && value.every((row) => row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).length)
  return { valid, rows: valid ? value : [] }
}

export const menuRoute = (menus, components) => {
  if (!Array.isArray(menus)) throw new Error('权限信息缺少菜单树')
  const normalize = (value) => String(value || '').split('?')[0]
    .replace(/^\/?(?:src\/)?views\//, '').replace(/^\/+/, '').replace(/\.vue$/, '').replace(/\/index$/, '')
  const wanted = new Set(components.map(normalize))
  const matches = new Set()
  const walk = (nodes, parent = '') => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (!node || typeof node.path !== 'string' || /^https?:\/\//.test(node.path)) continue
      const path = String(node?.path || '')
      const full = path.startsWith('/') ? path : `${parent.replace(/\/$/, '')}/${path}`.replace(/\/+/g, '/')
      if (wanted.has(normalize(node.component))) matches.add(full.split('?')[0])
      walk(node?.children, full)
    }
  }
  walk(menus)
  const ordered = [...matches].sort((left, right) => {
    const score = (value) => (value.startsWith('/settings/') ? 3 : value.startsWith('/plm/') ? 2 : 1)
    return score(right) - score(left) || left.localeCompare(right)
  })
  return ordered[0] || null
}

const recordList = (caseRecord, name, parsed, details) => {
  caseRecord.checks.push({ name, passed: parsed.valid, details: `${details}; rows=${parsed.rows.length}` })
  if (parsed.valid && !parsed.rows.length) caseRecord.notes.push(`缺前置：${details}查询为空；没有进行非空业务事实断言。`)
  return parsed.rows
}

const addPartial = (caseRecord, text) => {
  caseRecord.notes.push(`PARTIAL：${text}`)
}

// ---- dedicated config write-side helpers (only touch fixtures created in this run) ----
const expectedRejection = { expectedBusinessRejection: true }

const expectedServiceRejection = (message) => ({
  expectedBusinessRejection: {
    code: 500,
    message,
    allowServiceCode: true
  }
})

const qc004Rejections = Object.freeze({
  duplicateArea: { expectedBusinessRejection: { code: 1001001002, message: /库区编码.*已存在/ } },
  duplicateLocation: { expectedBusinessRejection: { code: 1001001001, message: /库位编码.*已存在/ } },
  crossLocation: {
    expectedBusinessRejection: { code: 1001001006, message: '库位所属库区与仓库不一致' }
  },
  disabledArea: expectedServiceRejection('该仓库未启用库区，请先在仓库档案启用库区'),
  disabledLocation: expectedServiceRejection('该仓库未启用库位，请先在仓库档案启用库位'),
  inUse: { expectedBusinessRejection: { code: 1001001003, message: /已被库存、未完成任务或未完成单据引用/ } },
  missingArea: expectedServiceRejection('未找到对应数据')
})

const qc005Rejections = Object.freeze({
  duplicate: expectedServiceRejection(/Duplicate entry .* for key 'mes_stk_io\.uk_mes_stk_io_tenant_bill_no'/),
  effectiveEdit: expectedServiceRejection('库存期初已生效，不能直接修改；请先反审核后再按受控流程修正')
})

const qc008Rejection = expectedServiceRejection('启用库位前必须先启用库区')
const qc009Rejection = expectedServiceRejection(/业务出入库类型不存在或已停用/)
const qc009MissingRuleRejection = expectedServiceRejection(/业务出入库类型未配置映射规则/)
const qc009MissingDataRejection = expectedServiceRejection('未找到对应数据')

const expectedCleanupRejection = (pathname) => {
  if (pathname.startsWith('/mes/basMaterial/delete?')) {
    return { expectedBusinessRejection: {
      code: 500,
      message: /被以下单据引用.*库存记录.*不允许删除/,
      allowServiceCode: true
    } }
  }
  if (pathname.startsWith('/mes/wms-house-location/delete?')) {
    return { expectedBusinessRejection: {
      code: 1001001003,
      message: /已被库存、未完成任务或未完成单据引用/
    } }
  }
  if (pathname.startsWith('/mes/wmsHouseArea/delete?')) {
    return { expectedBusinessRejection: {
      code: 500,
      message: /该库区下存在库位，请先删除库位后再删除库区/,
      allowServiceCode: true
    } }
  }
  if (pathname.startsWith('/mes/wmsWareHouse/delete?')) {
    return { expectedBusinessRejection: {
      code: 500,
      message: /已被引用，不能删除/,
      allowServiceCode: true
    } }
  }
  return undefined
}

const withCleanupRejectionContracts = (api) => ({
  ...api,
  deleteBusiness: (pathname, options) =>
    api.deleteBusiness(pathname, expectedCleanupRejection(pathname) || options)
})

const qc009DictionaryBody = (token) => {
  const suffix = compactCode(token)
  return {
    sort: 9999,
    label: `E2E-QC-009 ${suffix}`,
    value: `E2E_WMS_QC009_${suffix}`,
    dictType: 'wms_business_io_type',
    status: 0,
    colorType: 'default',
    cssClass: '',
    remark: `${WMS_FIXTURE_MARK} ${token}`
  }
}

const qc009CatalogAssertions = Object.freeze([
  '企业自定义出入库类型可直接在字典新增，不强制要求配置映射规则',
  '未配置映射规则时仅快照企业业务类型名称，核心出入库类型与库存方向沿用表单选择',
  '企业业务类型编码必须来自字典 wms_business_io_type，非字典编码被后端拒绝',
  '已配置启用状态的映射规则时，核心库存类型收敛到规则值并做方向一致性校验'
])

const initializeQc009CatalogChecks = (caseRecord) => {
  caseRecord.catalogAssertions = qc009CatalogAssertions.map((assertion, index) => ({
    index,
    assertion,
    status: 'GAP',
    evidenceChecks: [],
    details: '本轮尚未执行该原断言'
  }))
}

const markQc009CatalogCheck = (caseRecord, index, evidenceChecks, gap = '') => {
  const row = caseRecord.catalogAssertions?.[index]
  if (!row) return
  const checks = evidenceChecks.map((name) => caseRecord.checks.find((check) => check.name === name))
  row.evidenceChecks = [...evidenceChecks]
  row.status = !gap && checks.length > 0 && checks.every((check) => check?.passed === true)
    ? 'VERIFIED'
    : 'GAP'
  row.details = [
    gap,
    ...checks.map((check, position) => check
      ? `${check.name}: ${check.details}`
      : `缺证: ${evidenceChecks[position]}`)
  ].filter(Boolean).join('; ')
}

const stableInventorySnapshot = (rows) => JSON.stringify(
  rows.map((row) => Object.fromEntries(Object.keys(row || {}).sort().map((key) => [key, row[key]])))
    .sort((left, right) => String(left.id || '').localeCompare(String(right.id || '')))
)

const quantity = (value) => Number(value || 0)

const inventoryTotal = (row) => [
  row?.qty,
  row?.availableQty,
  row?.lockQty,
  row?.holdQty,
  row?.frozenQty,
  row?.pendingPutawayQty
].map(quantity)

const inventoryConserved = (row) => {
  if (!row) return false
  const [total, available, lock, hold, frozen, pending] = inventoryTotal(row)
  return Math.abs(total - (available + lock + hold + frozen + pending)) < 0.000001
}

const pageRowsFromResponse = (response) => {
  const data = response?.data
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.list)) return data.list
  if (Array.isArray(data?.records)) return data.records
  return []
}

const readDeletedResponse = (response) =>
  matchesExpectedBusinessRejection(response, qc009MissingDataRejection.expectedBusinessRejection) ||
  ((response?.code === 0 || (response?.code === 200 && response?.success === true)) && response.data === null)

const runQc009WriteSide = async (api, caseRecord, dependencies = {}) => {
  if (!Array.isArray(caseRecord.catalogAssertions)) initializeQc009CatalogChecks(caseRecord)
  if (!isWmsWriteEnabled()) {
    addPartial(caseRecord, '未启用 CFOR_E2E_WRITE_FIXTURES=true，未创建 QC-009 正式字典和草稿夹具。')
    return { covered: false }
  }
  const prepareFixture = dependencies.prepareWmsFixture || prepareWmsFixture
  const readInventory = dependencies.inventorySnapshot || inventorySnapshot
  const fixture = await prepareFixture(api, caseRecord, 6)
  const dictionary = qc009DictionaryBody(fixture.token)
  let dictionaryId = null
  let mappingId = null
  let mappingRemark = null
  let inboundCoreCode = null
  let outboundCoreCode = null
  let draftId = null
  let mappedDraftId = null
  try {
    const createdDictionaryId = dataOf(
      await api.postBusiness('/system/dict-data/create', dictionary),
      'QC-009 专属企业业务类型字典创建'
    )
    if (createdDictionaryId === undefined || createdDictionaryId === null || String(createdDictionaryId).trim() === '') {
      throw new Error('QC-009 专属企业业务类型字典创建未返回稳定 ID')
    }
    dictionaryId = String(createdDictionaryId)
    caseRecord.fixtures = [...(caseRecord.fixtures || []), {
      kind: 'qc009Dictionary',
      id: dictionaryId,
      value: dictionary.value,
      token: fixture.token
    }]
    const dictionaryRow = dataOf(
      await api.getBusiness(`/system/dict-data/get?id=${encodeURIComponent(dictionaryId)}`),
      'QC-009 专属企业业务类型字典回读'
    )
    caseRecord.checks.push({
      name: '创建并回读专属未映射企业业务类型字典',
      passed:
        String(dictionaryRow?.id) === dictionaryId &&
        dictionaryRow?.dictType === dictionary.dictType &&
        dictionaryRow?.value === dictionary.value &&
        dictionaryRow?.label === dictionary.label &&
        Number(dictionaryRow?.status) === 0,
      details: `id=${dictionaryId}; value=${dictionary.value}; status=${dictionaryRow?.status}`
    })
    const mappingRows = pageRowsFromResponse(await api.getBusiness(
      `/wms/business-io-type-rule/page?pageNo=1&pageSize=100&businessTypeCode=${encodeURIComponent(dictionary.value)}`
    ))
    const unmapped = !mappingRows.some((row) => String(row?.businessTypeCode) === dictionary.value)
    caseRecord.checks.push({
      name: '专属企业业务类型创建后仍无映射规则',
      passed: unmapped,
      details: `value=${dictionary.value}; matchingRules=${mappingRows.length}`
    })
    if (!unmapped) throw new Error(`QC-009 专属企业业务类型意外已有映射规则：${dictionary.value}`)

    const body = {
      billNo: `QC9-${compactCode(fixture.token)}`,
      billDate: new Date().toISOString().slice(0, 10),
      subject: `${fixture.token} unmapped business type draft`,
      remark: `${WMS_FIXTURE_MARK} ${fixture.token}`,
      stockIoType: '106',
      businessTypeCode: dictionary.value,
      isAuto: 0,
      stkIoEntryList: [{
        materialId: String(fixture.material.id),
        unitId: String(fixture.unit.id),
        qty: 1,
        cost: 1,
        warehouseId: String(fixture.warehouse.id),
        wareAreaId: String(fixture.area.id),
        wareLocationId: String(fixture.location.id),
        batchNo: `${fixture.token}-QC9-DRAFT`,
        entryNo: 1,
        stockIoType: '106',
        stockIoDirection: '1',
        isQc: 0,
        settleQty: 1
      }],
      stkIoDistributionList: [],
      stkIoBomList: []
    }
    const invalidBillNo = `QC9-ILLEGAL-${compactCode(fixture.token)}`
    const invalidCode = `E2E_WMS_QC009_ILLEGAL_${compactCode(fixture.token)}`
    const invalidResponse = await api.post('/mes/stkIo/add/save', {
      ...body,
      billNo: invalidBillNo,
      subject: `${fixture.token} invalid business type draft`,
      businessTypeCode: invalidCode
    }, qc009Rejection)
    const invalidRejected = matchesExpectedBusinessRejection(
      invalidResponse,
      qc009Rejection.expectedBusinessRejection
    )
    caseRecord.checks.push({
      name: '写侧拒绝不在字典中的企业业务类型',
      passed: invalidRejected && String(invalidResponse?.msg || invalidResponse?.message || '').includes('业务出入库类型'),
      details: `code=${invalidResponse?.code}; msg=${invalidResponse?.msg || invalidResponse?.message || ''}`
    })
    const invalidRows = pageRowsFromResponse(await api.getBusiness(
      `/mes/stkIo/list?pageNo=1&pageSize=100&billNo=${encodeURIComponent(invalidBillNo)}`
    ))
    const invalidNoDraft = !invalidRows.some((row) => String(row?.billNo) === invalidBillNo)
    caseRecord.checks.push({
      name: '非法企业业务类型拒绝后按单号回读没有生成单据',
      passed: invalidRejected && invalidNoDraft,
      details: `code=${invalidResponse?.code}; msg=${invalidResponse?.msg || invalidResponse?.message || ''}; billNo=${invalidBillNo}; rows=${invalidRows.length}`
    })

    const beforeInventory = await readInventory(api, fixture, fixture.material.id)
    const saveResponse = await api.post('/mes/stkIo/add/save', body, qc009MissingRuleRejection)
    if (!isBusinessSuccess(saveResponse)) {
      if (matchesExpectedBusinessRejection(
        saveResponse,
        qc009MissingRuleRejection.expectedBusinessRejection
      )) {
        caseRecord.checks.push({
          name: '合法未映射企业业务类型可正式保存出入库草稿',
          passed: false,
          details: `code=${saveResponse?.code}; msg=${saveResponse?.msg || saveResponse?.message || ''}`
        })
        caseRecord.notes.push(
          '后端真实缺陷：正式 save 仍要求企业业务类型映射规则，违反 QC-009 已确认的“未映射类型可直接保存”契约；最小修复是让 /mes/stkIo/add/save 继续走 resolveOptional，仅在字典有效时写名称快照并保留表单 106/方向。'
        )
        return { covered: false, backendMappingRequired: true }
      }
      throw new Error(`QC-009 正式草稿保存失败：${JSON.stringify(saveResponse)}`)
    }

    const savedPage = await api.getBusiness(
      `/mes/stkIo/list?pageNo=1&pageSize=100&billNo=${encodeURIComponent(body.billNo)}`
    )
    const saved = pageRowsFromResponse(savedPage).find((row) =>
      String(row?.billNo) === body.billNo && isOwnedFixture(row, fixture.token)
    )
    draftId = saved?.id == null ? null : String(saved.id)
    caseRecord.checks.push({
      name: '合法未映射企业业务类型正式保存草稿并按单号回读',
      passed: Boolean(draftId),
      details: `billNo=${body.billNo}; id=${draftId || ''}`
    })
    if (!draftId) throw new Error(`QC-009 正式草稿未回读：${body.billNo}`)

    const main = dataOf(
      await api.getBusiness(`/mes/stkIo/queryById?id=${encodeURIComponent(draftId)}`),
      'QC-009 正式草稿主单快照'
    )
    const entries = dataOf(
      await api.getBusiness(`/mes/stkIo/queryEntryByMainId?id=${encodeURIComponent(draftId)}`),
      'QC-009 正式草稿明细快照'
    )
    const entry = Array.isArray(entries) ? entries[0] : null
    const snapshotPassed =
      String(main?.businessTypeCode) === dictionary.value &&
      String(main?.businessTypeName) === dictionary.label &&
      String(main?.stockIoType) === '106' &&
      String(entry?.stockIoDirection) === '1'
    caseRecord.checks.push({
      name: '正式草稿回读企业名称快照、核心 106 和入库方向',
      passed: snapshotPassed,
      details: `code=${main?.businessTypeCode}; name=${main?.businessTypeName}; core=${main?.stockIoType}; direction=${entry?.stockIoDirection}`
    })

    const afterSaveInventory = await readInventory(api, fixture, fixture.material.id)
    const inventoryUnchanged = stableInventorySnapshot(beforeInventory) === stableInventorySnapshot(afterSaveInventory)
    caseRecord.checks.push({
      name: '保存企业业务类型草稿不改变 mes_stk_inventory',
      passed: inventoryUnchanged,
      details: `before=${beforeInventory.length}; after=${afterSaveInventory.length}`
    })

    const coreOptions = pageRowsFromResponse(await api.getBusiness('/wms/business-io-type-rule/core-types'))
    const inboundCore = coreOptions.find((item) =>
      String(item?.direction).toUpperCase() === 'IN' && String(item?.code) !== '106'
    )
    const outboundCore = coreOptions.find((item) => String(item?.direction).toUpperCase() === 'OUT')
    if (!inboundCore || !outboundCore) {
      throw new Error(`QC-009 正式核心类型目录缺少 IN/OUT 选项：${JSON.stringify(coreOptions)}`)
    }
    inboundCoreCode = String(inboundCore.code)
    outboundCoreCode = String(outboundCore.code)
    mappingRemark = `${WMS_FIXTURE_MARK} ${fixture.token} QC009 mapping`
    const mappingBody = {
      businessTypeCode: dictionary.value,
      businessTypeName: dictionary.label,
      coreStockIoType: inboundCoreCode,
      active: true,
      remark: mappingRemark
    }
    mappingId = String(dataOf(
      await api.postBusiness('/wms/business-io-type-rule/create', mappingBody),
      'QC-009 专属企业业务类型映射创建'
    ))
    if (!mappingId || mappingId === 'undefined' || mappingId === 'null') {
      throw new Error('QC-009 专属映射创建未返回稳定 ID')
    }
    caseRecord.fixtures = [...(caseRecord.fixtures || []), {
      kind: 'qc009BusinessIoTypeRule',
      id: mappingId,
      businessTypeCode: dictionary.value,
      token: fixture.token
    }]
    const mappingRow = dataOf(
      await api.getBusiness(`/wms/business-io-type-rule/get?id=${encodeURIComponent(mappingId)}`),
      'QC-009 专属企业业务类型映射回读'
    )
    const mappingPassed = String(mappingRow?.id) === mappingId &&
      String(mappingRow?.businessTypeCode) === dictionary.value &&
      String(mappingRow?.coreStockIoType) === inboundCoreCode &&
      mappingRow?.active === true &&
      String(mappingRow?.direction).toUpperCase() === 'IN'
    caseRecord.checks.push({
      name: '专属字典通过正式 API 创建并回读唯一启用映射',
      passed: mappingPassed,
      details: `id=${mappingId}; code=${mappingRow?.businessTypeCode}; core=${mappingRow?.coreStockIoType}; direction=${mappingRow?.direction}; active=${mappingRow?.active}`
    })
    if (!mappingPassed) throw new Error(`QC-009 专属映射回读不符合唯一启用契约：${JSON.stringify(mappingRow)}`)

    const mappedBody = {
      ...body,
      billNo: `QC9-MAPPED-${compactCode(fixture.token)}`,
      subject: `${fixture.token} mapped business type draft`,
      stockIoType: '106',
      stkIoEntryList: [{ ...body.stkIoEntryList[0], batchNo: `${fixture.token}-QC9-MAPPED`, stockIoType: '106', stockIoDirection: '1' }]
    }
    const mappedSave = await api.post('/mes/stkIo/add/save', mappedBody, qc009MissingRuleRejection)
    if (!isBusinessSuccess(mappedSave)) {
      throw new Error(`QC-009 启用映射正式草稿保存失败：${JSON.stringify(mappedSave)}`)
    }
    const mappedPage = await api.getBusiness(
      `/mes/stkIo/list?pageNo=1&pageSize=100&billNo=${encodeURIComponent(mappedBody.billNo)}`
    )
    const mapped = pageRowsFromResponse(mappedPage).find((row) =>
      String(row?.billNo) === mappedBody.billNo && isOwnedFixture(row, fixture.token)
    )
    mappedDraftId = mapped?.id == null ? null : String(mapped.id)
    const mappedMain = mappedDraftId
      ? dataOf(await api.getBusiness(`/mes/stkIo/queryById?id=${encodeURIComponent(mappedDraftId)}`), 'QC-009 启用映射草稿主单回读')
      : null
    const mappedEntries = mappedDraftId
      ? dataOf(await api.getBusiness(`/mes/stkIo/queryEntryByMainId?id=${encodeURIComponent(mappedDraftId)}`), 'QC-009 启用映射草稿明细回读')
      : []
    const mappedPassed = Boolean(mappedDraftId) &&
      String(mappedMain?.businessTypeCode) === dictionary.value &&
      String(mappedMain?.stockIoType) === inboundCoreCode &&
      String(mappedEntries?.[0]?.stockIoDirection) === '1'
    caseRecord.checks.push({
      name: '启用映射正式保存后核心类型收敛且保持入库方向',
      passed: mappedPassed,
      details: `billNo=${mappedBody.billNo}; id=${mappedDraftId || ''}; submittedCore=106; mappedCore=${mappedMain?.stockIoType}; mappedDirection=${mappedEntries?.[0]?.stockIoDirection}; ruleCore=${inboundCoreCode}`
    })
    if (mappedDraftId) {
      await api.deleteBusiness(`/mes/stkIo/delete?id=${encodeURIComponent(mappedDraftId)}`)
      mappedDraftId = null
    }

    const directionBody = {
      ...body,
      billNo: `QC9-DIRECTION-${compactCode(fixture.token)}`,
      subject: `${fixture.token} direction mismatch draft`,
      stockIoType: outboundCoreCode,
      stkIoEntryList: [{ ...body.stkIoEntryList[0], batchNo: `${fixture.token}-QC9-DIRECTION`, stockIoType: outboundCoreCode, stockIoDirection: '2' }]
    }
    const directionResponse = await api.post('/mes/stkIo/add/save', directionBody, {
      expectedBusinessRejection: {
        code: 500,
        message: /业务出入库类型【.*】的库存方向与当前单据不一致，请选择对应方向的类型/,
        allowServiceCode: true
      }
    })
    const directionRejected = matchesExpectedBusinessRejection(directionResponse, {
      code: 500,
      message: /业务出入库类型【.*】的库存方向与当前单据不一致，请选择对应方向的类型/,
      allowServiceCode: true
    })
    const directionRows = pageRowsFromResponse(await api.getBusiness(
      `/mes/stkIo/list?pageNo=1&pageSize=100&billNo=${encodeURIComponent(directionBody.billNo)}`
    ))
    const directionNoDraft = !directionRows.some((row) => String(row?.billNo) === directionBody.billNo)
    caseRecord.checks.push({
      name: '启用映射遇方向不一致时按 controller 领域契约拒绝且不落单',
      passed: directionRejected && directionNoDraft,
      details: `code=${directionResponse?.code}; msg=${directionResponse?.msg || directionResponse?.message || ''}; billNo=${directionBody.billNo}; rows=${directionRows.length}`
    })

    markQc009CatalogCheck(caseRecord, 0, [
      '创建并回读专属未映射企业业务类型字典',
      '专属企业业务类型创建后仍无映射规则'
    ])
    markQc009CatalogCheck(caseRecord, 1, [
      '合法未映射企业业务类型正式保存草稿并按单号回读',
      '正式草稿回读企业名称快照、核心 106 和入库方向',
      '保存企业业务类型草稿不改变 mes_stk_inventory'
    ])
    markQc009CatalogCheck(caseRecord, 2, [
      '写侧拒绝不在字典中的企业业务类型',
      '非法企业业务类型拒绝后按单号回读没有生成单据'
    ])
    markQc009CatalogCheck(caseRecord, 3, [
      '专属字典通过正式 API 创建并回读唯一启用映射',
      '启用映射正式保存后核心类型收敛且保持入库方向',
      '启用映射遇方向不一致时按 controller 领域契约拒绝且不落单'
    ])

    await api.deleteBusiness(`/mes/stkIo/delete?id=${encodeURIComponent(draftId)}`)
    const deletedDraft = await api.get(
      `/mes/stkIo/queryById?id=${encodeURIComponent(draftId)}`,
      qc009MissingDataRejection
    )
    caseRecord.checks.push({
      name: '正式草稿删除后回读不存在',
      passed: readDeletedResponse(deletedDraft),
      details: `id=${draftId}; code=${deletedDraft?.code}; msg=${deletedDraft?.msg || deletedDraft?.message || ''}`
    })
    draftId = null
    caseRecord.evidence.push(
      `QC-009 专属字典 ${dictionary.value} 创建/回读、未映射 106 草稿快照、启用映射核心收敛、方向冲突拒绝、非法编码无落单、库存前后快照及正式清理`
    )
    return {
      covered: snapshotPassed && inventoryUnchanged && mappingPassed && mappedPassed &&
        directionRejected && directionNoDraft && invalidRejected && invalidNoDraft
    }
  } finally {
    if (draftId) {
      await api.deleteBusiness(`/mes/stkIo/delete?id=${encodeURIComponent(draftId)}`)
    }
    if (mappedDraftId) {
      await api.deleteBusiness(`/mes/stkIo/delete?id=${encodeURIComponent(mappedDraftId)}`)
    }
    if (mappingId) {
      const mapping = dataOf(
        await api.getBusiness(`/wms/business-io-type-rule/get?id=${encodeURIComponent(mappingId)}`),
        'QC-009 映射清理前归属回读'
      )
      if (String(mapping?.id) !== mappingId || String(mapping?.businessTypeCode) !== dictionary.value ||
          String(mapping?.remark || '') !== String(mappingRemark || '')) {
        throw new Error(`QC-009 映射归属校验失败，拒绝清理：${mappingId}`)
      }
      await api.deleteBusiness(`/wms/business-io-type-rule/delete?id=${encodeURIComponent(mappingId)}`)
      caseRecord.checks.push({
        name: '专属启用映射正式删除后不触碰平台默认规则',
        passed: true,
        details: `deletedRuleId=${mappingId}; businessTypeCode=${dictionary.value}`
      })
      mappingId = null
    }
    if (dictionaryId) {
      const current = dataOf(
        await api.getBusiness(`/system/dict-data/get?id=${encodeURIComponent(dictionaryId)}`),
        'QC-009 字典清理前归属回读'
      )
      if (String(current?.id) !== dictionaryId || current?.dictType !== dictionary.dictType ||
          current?.value !== dictionary.value || current?.remark !== dictionary.remark) {
        throw new Error(`QC-009 字典归属校验失败，拒绝清理：${dictionaryId}`)
      }
      if (Number(current?.status) !== 1) {
        await api.putBusiness('/system/dict-data/update', { ...dictionary, id: dictionaryId, status: 1 })
      }
      await api.deleteBusiness(`/system/dict-data/delete?id=${encodeURIComponent(dictionaryId)}`)
      const deletedDictionary = await api.get(
        `/system/dict-data/get?id=${encodeURIComponent(dictionaryId)}`,
        qc009MissingDataRejection
      )
      const deleted = readDeletedResponse(deletedDictionary)
      caseRecord.checks.push({
        name: '专属企业业务类型停用后正式删除并回读不存在',
        passed: deleted,
        details: `id=${dictionaryId}; code=${deletedDictionary?.code}; msg=${deletedDictionary?.msg || deletedDictionary?.message || ''}`
      })
    }
  }
}

const rawCall = async (invoke, options = {}) => {
  // Transport failures must reach the runner unchanged, never become business rejections.
  const response = await invoke(options)
  const expectedBusinessRejectionMatched = matchesExpectedBusinessRejection(
    response,
    options.expectedBusinessRejection
  )
  return {
    ok: isBusinessSuccess(response),
    businessRejection: isBusinessRejection(response) || expectedBusinessRejectionMatched,
    expectedBusinessRejectionMatched,
    code: response?.code,
    success: response?.success,
    msg: response?.msg || response?.message || '',
    message: response?.message,
    data: response?.data
  }
}

const configWriteToken = (kind) =>
  `E2E-WMS-${kind}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

const compactCode = (token) => token.replace(/[^A-Za-z0-9]/g, '').slice(-22)

const findTreeWarehouse = (nodes, { code, name } = {}) => {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    // /mes/wmsWareHouse/allTree 节点只暴露 id/name/pid，需要按名称回读（code 作为兜底）。
    if (name !== undefined && String(node?.name) === String(name)) return node
    if (code !== undefined && String(node?.code) === String(code)) return node
    const child = findTreeWarehouse(node?.children, { code, name })
    if (child) return child
  }
  return null
}

const findWarehouseByCode = async (api, { code, name }) => {
  const tree = await api.getBusiness('/mes/wmsWareHouse/allTree')
  return findTreeWarehouse(Array.isArray(tree?.data) ? tree.data : [], { code, name })
}

const forgetFixture = (caseRecord, kind, id) => {
  caseRecord.fixtures = (caseRecord.fixtures || []).filter(
    (item) => !(item.kind === kind && String(item.id) === String(id))
  )
}

export const coreDirections = Object.freeze({
  101: 'IN', 201: 'OUT', 104: 'IN', 107: 'IN', 207: 'OUT', 108: 'IN',
  208: 'OUT', 109: 'IN', 209: 'OUT', 199: 'IN', 299: 'OUT', 203: 'OUT',
  103: 'IN', 110: 'IN', 210: 'OUT', 106: 'IN', 301: 'OUT', 302: 'IN'
})

export const finiteQuantity = (value) =>
  ['number', 'string'].includes(typeof value) && String(value).trim() !== '' && Number.isFinite(Number(value))

export const duplicateCodes = (rows, field) => {
  const seen = new Set()
  return rows.filter((row) => {
    const key = `${row.houseId}|${row[field]}`
    if (seen.has(key)) return true
    seen.add(key)
    return false
  })
}

/**
 * WMS-QC-004 写侧：专属双仓库夹具下验证库区/库位编码唯一、跨仓归属拒绝、
 * 未启用库区/库位拒绝建档，以及未完成出入库单引用的库位禁止删除和调整归属。
 * 所有夹具均带本轮 token，结束后由 cleanupWmsFixtures 按 ID 清理。
 */
const runQc004WriteSide = async (api, caseRecord) => {
  if (!isWmsWriteEnabled()) {
    addPartial(caseRecord, '未启用 CFOR_E2E_WRITE_FIXTURES=true，未创建库区/库位写侧夹具。')
    return { covered: false }
  }
  const fixture = await prepareWmsFixture(api, caseRecord, 4)
  const other = await prepareWmsFixture(api, caseRecord, 5)
  const token = fixture.token

  const duplicateArea = await rawCall((options) => api.post('/mes/wmsHouseArea/add', {
    areaCode: fixture.area.areaCode,
    areaName: `E2E-QC-004 duplicate area ${token}`,
    houseId: fixture.warehouse.id,
    isEnabled: true,
    remark: `${WMS_FIXTURE_MARK} ${token}`
  }, options), qc004Rejections.duplicateArea)
  caseRecord.checks.push({
    name: '同一仓库重复库区编码被后端拒绝',
    passed: duplicateArea.businessRejection,
    details: `code=${duplicateArea.code}; msg=${duplicateArea.msg}`
  })

  const duplicateLocation = await rawCall((options) => api.post('/mes/wms-house-location/create', {
    locationName: `E2E-QC-004 duplicate location ${token}`,
    locationCode: fixture.location.locationCode,
    houseId: fixture.warehouse.id,
    areaId: fixture.area.id,
    isEnabled: true,
    locationType: 1,
    remark: `${WMS_FIXTURE_MARK} ${token}`
  }, options), qc004Rejections.duplicateLocation)
  caseRecord.checks.push({
    name: '同一仓库重复库位编码被后端拒绝',
    passed: duplicateLocation.businessRejection,
    details: `code=${duplicateLocation.code}; msg=${duplicateLocation.msg}`
  })

  const crossLocationCode = `QC4X${compactCode(token)}`
  const crossLocation = await rawCall((options) => api.post('/mes/wms-house-location/create', {
    locationName: `E2E-QC-004 cross ${token}`,
    locationCode: crossLocationCode,
    houseId: fixture.warehouse.id,
    areaId: other.area.id,
    isEnabled: true,
    locationType: 1
  }, options), qc004Rejections.crossLocation)
  const afterCrossCreate = strictList(await api.getBusiness(
    `/mes/wms-house-location/page?pageNo=1&pageSize=100&locationCode=${encodeURIComponent(crossLocationCode)}`
  ))
  caseRecord.checks.push({
    name: '库位所属库区与仓库不一致被后端拒绝',
    passed: crossLocation.businessRejection && afterCrossCreate.valid &&
      afterCrossCreate.rows.every((row) => row.locationCode !== crossLocationCode),
    details: `code=${crossLocation.code}; msg=${crossLocation.msg}`
  })
  await verifyCrossAreaRejection(api, caseRecord, fixture, other)

  // 未启用库区的仓库不能建库区：专属仓库显式 areaEnabled=false/locationEnabled=false
  const disabledCode = `QC4D${compactCode(token)}`
  const disabledWarehouse = await rawCall(() => api.post('/mes/wmsWareHouse/add', {
    code: disabledCode,
    name: `E2E-QC-004 disabled ${disabledCode}`,
    pid: '0',
    isEnabled: true,
    areaEnabled: false,
    locationEnabled: false,
    mark: `${WMS_FIXTURE_MARK} ${token}`
  }))
  let disabledId = null
  if (disabledWarehouse.ok) {
    const disabledRow = await findWarehouseByCode(api, {
      code: disabledCode,
      name: `E2E-QC-004 disabled ${disabledCode}`
    })
    disabledId = disabledRow?.id ? String(disabledRow.id) : null
    if (disabledId) caseRecord.fixtures = [...(caseRecord.fixtures || []), { kind: 'warehouse', id: disabledId, code: disabledCode, token }]
  }
  caseRecord.checks.push({
    name: '创建未启用库区/库位的专属仓库成功',
    passed: disabledWarehouse.ok && Boolean(disabledId),
    details: `code=${disabledWarehouse.code}; warehouseId=${disabledId || ''}`
  })
  if (disabledId) {
    const disabledArea = await rawCall((options) => api.post('/mes/wmsHouseArea/add', {
      areaCode: `QC4DA${compactCode(token)}`,
      areaName: `E2E-QC-004 disabled area ${token}`,
      houseId: disabledId,
      isEnabled: true,
      remark: `${WMS_FIXTURE_MARK} ${token}`
    }, options), qc004Rejections.disabledArea)
    caseRecord.checks.push({
      name: '未启用库区的仓库创建库区被后端拒绝',
      passed: disabledArea.businessRejection,
      details: `code=${disabledArea.code}; msg=${disabledArea.msg}`
    })
    const disabledLocation = await rawCall((options) => api.post('/mes/wms-house-location/create', {
      locationName: `E2E-QC-004 disabled location ${token}`,
      locationCode: `QC4DL${compactCode(token)}`,
      houseId: disabledId,
      areaId: fixture.area.id,
      isEnabled: true,
      locationType: 1
    }, options), qc004Rejections.disabledLocation)
    caseRecord.checks.push({
      name: '未启用库位的仓库创建库位被后端拒绝',
      passed: disabledLocation.businessRejection,
      details: `code=${disabledLocation.code}; msg=${disabledLocation.msg}`
    })
  }

  await verifyCrossWarehouseCodes(api, caseRecord, fixture, other)
  // 未完成出入库单引用库位：创建 101 草稿（不生效），验证库位删除/调整归属被拒绝
  const draftBillNo = `QC4-${compactCode(token)}`
  const draft = await rawCall(() => api.post('/mes/stkIo/add/save', {
    billNo: draftBillNo,
    billDate: new Date().toISOString().slice(0, 10),
    subject: `${token} qc004 unfinished draft`,
    remark: `${WMS_FIXTURE_MARK} ${token}`,
    stockIoType: '101',
    isAuto: 0,
    stkIoEntryList: [{
      materialId: String(fixture.material.id),
      unitId: String(fixture.unit.id),
      qty: 1,
      cost: 1,
      warehouseId: fixture.warehouse.id,
      wareAreaId: fixture.area.id,
      wareLocationId: fixture.location.id,
      batchNo: `${token}-QC4-DRAFT`,
      entryNo: 1,
      stockIoType: '101',
      stockIoDirection: '1',
      isQc: 0,
      settleQty: 1
    }],
    stkIoDistributionList: [],
    stkIoBomList: []
  }))
  caseRecord.checks.push({
    name: '创建引用专属库位的未生效出入库草稿',
    passed: draft.ok,
    details: `code=${draft.code}; billNo=${draftBillNo}`
  })

  let draftId = null
  if (draft.ok) {
    const list = await rawCall(() => api.get(
      `/mes/stkIo/list?pageNo=1&pageSize=100&billNo=${encodeURIComponent(draftBillNo)}`))
    const rows = Array.isArray(list.data?.list)
      ? list.data.list
      : (Array.isArray(list.data?.records) ? list.data.records : [])
    draftId = rows.find((row) => String(row?.billNo) === draftBillNo)?.id
    draftId = draftId === undefined || draftId === null ? null : String(draftId)
  }

  if (draftId) {
    await verifyLocationOccupied(api, caseRecord, fixture, other, '未完成出入库占用')
    const inUseDelete = await rawCall(
      (options) => api.delete(`/mes/wms-house-location/delete?id=${encodeURIComponent(fixture.location.id)}`, options),
      qc004Rejections.inUse
    )
    caseRecord.checks.push({
      name: '库位存在未完成出入库单时删除被后端拒绝',
      passed: inUseDelete.businessRejection,
      details: `code=${inUseDelete.code}; msg=${inUseDelete.msg}`
    })
    const inUseMove = await rawCall((options) => api.put('/mes/wms-house-location/update', {
      // 雪花 ID 超过 Number.MAX_SAFE_INTEGER，必须以字符串传输避免精度丢失。
      id: String(fixture.location.id),
      locationName: `E2E-QC-004 move ${token}`,
      locationCode: fixture.location.locationCode,
      houseId: other.warehouse.id,
      areaId: other.area.id,
      isEnabled: true,
      locationType: 1
    }, options), qc004Rejections.inUse)
    caseRecord.checks.push({
      name: '库位存在未完成出入库单时调整仓库/库区归属被后端拒绝',
      passed: inUseMove.businessRejection,
      details: `code=${inUseMove.code}; msg=${inUseMove.msg}`
    })

    // 草稿按本轮 billNo 精确定位后删除，随后库位删除保护应解除，避免遗留占用
    const cleanupDraft = await rawCall(() => api.delete(
      `/mes/stkIo/delete?id=${encodeURIComponent(draftId)}`))
    caseRecord.checks.push({
      name: '本轮 QC-004 未生效草稿可按 ID 清理',
      passed: cleanupDraft.ok,
      details: `code=${cleanupDraft.code}; id=${draftId}`
    })
    if (cleanupDraft.ok) {
      const afterRelease = await rawCall(() => api.delete(
        `/mes/wms-house-location/delete?id=${encodeURIComponent(fixture.location.id)}`))
      caseRecord.checks.push({
        name: '解除未完成单据引用后专属库位可删除',
        passed: afterRelease.ok,
        details: `code=${afterRelease.code}; msg=${afterRelease.msg}`
      })
      if (afterRelease.ok) forgetFixture(caseRecord, 'location', fixture.location.id)
    }
  } else {
    addPartial(caseRecord, `未回读到 QC-004 未完成草稿 ${draftBillNo} 的 ID，库位引用删除保护未做写侧断言。`)
  }

  caseRecord.evidence.push(
    '专属双仓库夹具验证库区/库位编码唯一、跨仓归属拒绝、未启用层级拒绝建档，' +
      '以及未完成出入库单引用的库位删除/调整归属拒绝；草稿和专属档案按 ID 清理'
  )
  const references = await verifyLocationReferenceClosure(api, caseRecord, other)
  return {
    covered: draftId !== null,
    pageWarehouse: references.inventoryFixture.warehouse,
    referenceFixture: references.inventoryFixture
  }
}

/**
 * WMS-QC-008 写侧：专属仓库验证新增默认关闭库区/库位、非法组合后端拒绝、
 * 合法启用持久化，以及关闭库区时库位开关必须一并关闭。
 */
const runQc008WriteSide = async (api, caseRecord) => {
  if (!isWmsWriteEnabled()) {
    addPartial(caseRecord, '未启用 CFOR_E2E_WRITE_FIXTURES=true，未创建仓库开关写侧夹具。')
    return { covered: false }
  }
  const token = configWriteToken('QC8')
  const code = `QC8${compactCode(token)}`
  const name = `E2E-QC-008 ${code}`
  const add = await rawCall(() => api.post('/mes/wmsWareHouse/add', {
    code,
    name,
    pid: '0',
    wareType: 'entity',
    wareAddress: '',
    isEnabled: true,
    mark: `${WMS_FIXTURE_MARK} ${token}`
  }))
  const row = add.ok ? await findWarehouseByCode(api, { code, name }) : null
  const id = row?.id ? String(row.id) : null
  if (id) {
    caseRecord.fixtures = [...(caseRecord.fixtures || []), { kind: 'warehouse', id, code, token }]
  }
  caseRecord.checks.push({
    name: '新增专属仓库成功并回读主键',
    passed: add.ok && Boolean(id),
    details: `code=${add.code}; warehouseId=${id || ''}`
  })
  if (!id) {
    addPartial(caseRecord, `QC-008 专属仓库 ${code} 创建或回读失败，开关写侧未执行。`)
    return { covered: false }
  }

  const detail = await rawCall(() => api.get(`/mes/wmsWareHouse/queryById?id=${encodeURIComponent(id)}`))
  caseRecord.checks.push({
    name: '新增仓库默认关闭库区与库位',
    passed: detail.data?.areaEnabled === false && detail.data?.locationEnabled === false,
    details: `areaEnabled=${detail.data?.areaEnabled}; locationEnabled=${detail.data?.locationEnabled}`
  })

  const illegal = await rawCall((options) => api.put('/mes/wmsWareHouse/edit', {
    id, pid: '0', code, name: `E2E-QC-008 ${code}`, isEnabled: true,
    areaEnabled: false, locationEnabled: true
  }, options), qc008Rejection)
  const afterIllegal = await rawCall(() => api.get(`/mes/wmsWareHouse/queryById?id=${encodeURIComponent(id)}`))
  caseRecord.checks.push({
    name: '关闭库区同时启用库位被后端拒绝',
    passed: illegal.businessRejection,
    details: `code=${illegal.code}; msg=${illegal.msg}`
  })
  caseRecord.checks.push({
    name: '非法库区库位组合拒绝后仓库完整原值不变',
    passed: illegal.businessRejection &&
      JSON.stringify(detail.data) === JSON.stringify(afterIllegal.data),
    details: `warehouseId=${id}; code=${illegal.code}`
  })

  const enable = await rawCall(() => api.put('/mes/wmsWareHouse/edit', {
    id, pid: '0', code, name: `E2E-QC-008 ${code}`, isEnabled: true,
    areaEnabled: true, locationEnabled: true
  }))
  const afterEnable = enable.ok
    ? await rawCall(() => api.get(`/mes/wmsWareHouse/queryById?id=${encodeURIComponent(id)}`))
    : { data: {} }
  caseRecord.checks.push({
    name: '同时启用库区与库位可持久化',
    passed: enable.ok && afterEnable.data?.areaEnabled === true && afterEnable.data?.locationEnabled === true,
    details: `code=${enable.code}; areaEnabled=${afterEnable.data?.areaEnabled}; locationEnabled=${afterEnable.data?.locationEnabled}`
  })

  const closeAreaOnly = await rawCall((options) => api.put('/mes/wmsWareHouse/edit', {
    id, pid: '0', code, name: `E2E-QC-008 ${code}`, isEnabled: true, areaEnabled: false
  }, options), qc008Rejection)
  caseRecord.checks.push({
    name: '库位仍启用时单独关闭库区被后端拒绝',
    passed: closeAreaOnly.businessRejection,
    details: `code=${closeAreaOnly.code}; msg=${closeAreaOnly.msg}`
  })

  const closeBoth = await rawCall(() => api.put('/mes/wmsWareHouse/edit', {
    id, pid: '0', code, name: `E2E-QC-008 ${code}`, isEnabled: true,
    areaEnabled: false, locationEnabled: false
  }))
  const afterClose = closeBoth.ok
    ? await rawCall(() => api.get(`/mes/wmsWareHouse/queryById?id=${encodeURIComponent(id)}`))
    : { data: {} }
  caseRecord.checks.push({
    name: '库区与库位可一并关闭并持久化',
    passed: closeBoth.ok && afterClose.data?.areaEnabled === false && afterClose.data?.locationEnabled === false,
    details: `code=${closeBoth.code}; areaEnabled=${afterClose.data?.areaEnabled}; locationEnabled=${afterClose.data?.locationEnabled}`
  })

  caseRecord.evidence.push('专属测试仓库验证新增默认关闭、非法组合拒绝、合法启用持久化和一并关闭')
  return { covered: true, pageWarehouse: { id, code, name } }
}

/**
 * WMS-QC-006 write side: the business type must come from the platform
 * dictionary, the core stock type must remain a WMS enum value, the saved
 * label is a snapshot, and a disabled rule stops participating in stock IO.
 */
const runQc006WriteSide = async (api, caseRecord) => {
  if (!isWmsWriteEnabled()) {
    addPartial(caseRecord, '未启用 CFOR_E2E_WRITE_FIXTURES=true，未创建业务类型映射写侧夹具。')
    return { covered: false }
  }
  const fixture = await prepareWmsFixture(api, caseRecord, 7)
  const tag = configWriteToken('QC6')
  const value = `E2E_WMS_QC006_${compactCode(tag)}`
  const disabledValue = `E2E_WMS_QC006_DISABLED_${compactCode(tag)}`
  const unknownValue = `E2E_WMS_QC006_UNKNOWN_${compactCode(tag)}`
  const initialLabel = `E2E-QC006 业务类型 ${compactCode(tag)}`
  const renamedLabel = `${initialLabel} RENAMED`
  let dictionaryId = null
  let disabledDictionaryId = null
  let ruleId = null
  let draftId = null
  try {
    dictionaryId = String(dataOf(await api.postBusiness('/system/dict-data/create', {
      sort: 9998,
      label: initialLabel,
      value,
      dictType: 'wms_business_io_type',
      status: 0,
      colorType: 'default',
      cssClass: '',
      remark: `${WMS_FIXTURE_MARK} ${tag}`
    }), 'QC-006 专属业务类型字典创建'))
    caseRecord.fixtures = [...(caseRecord.fixtures || []), {
      kind: 'qc006Dictionary',
      id: dictionaryId,
      value,
      token: tag
    }]
    disabledDictionaryId = String(dataOf(await api.postBusiness('/system/dict-data/create', {
      sort: 9997,
      label: `${initialLabel} DISABLED`,
      value: disabledValue,
      dictType: 'wms_business_io_type',
      status: 1,
      colorType: 'default',
      cssClass: '',
      remark: `${WMS_FIXTURE_MARK} ${tag} disabled`
    }), 'QC-006 停用业务类型字典创建'))
    caseRecord.fixtures.push({
      kind: 'qc006Dictionary',
      id: disabledDictionaryId,
      value: disabledValue,
      token: tag
    })
    const dictionary = dataOf(await api.getBusiness(
      `/system/dict-data/get?id=${encodeURIComponent(dictionaryId)}`
    ), 'QC-006 专属业务类型字典回读')
    const disabledDictionary = dataOf(await api.getBusiness(
      `/system/dict-data/get?id=${encodeURIComponent(disabledDictionaryId)}`
    ), 'QC-006 停用业务类型字典回读')
    caseRecord.checks.push({
      name: '业务出入库类型字典编码有效且停用值状态可回读',
      passed:
        dictionary?.value === value &&
        Number(dictionary?.status) === 0 &&
        disabledDictionary?.value === disabledValue &&
        Number(disabledDictionary?.status) === 1,
      details: `enabledId=${dictionaryId}; disabledId=${disabledDictionaryId}`
    })

    const ruleBase = {
      businessTypeCode: value,
      coreStockIoType: '299',
      active: true,
      remark: `QC-006 isolated rule ${tag}`
    }
    const unknownRejected = await api.post('/wms/business-io-type-rule/create', {
      ...ruleBase,
      businessTypeCode: unknownValue
    }, expectedServiceRejection(/业务出入库类型不存在或已停用/))
    caseRecord.checks.push({
      name: '未知业务类型编码创建映射规则被后端拒绝',
      passed:
        matchesExpectedBusinessRejection(
          unknownRejected,
          expectedServiceRejection(/业务出入库类型不存在或已停用/).expectedBusinessRejection
        ),
      details: `code=${unknownRejected?.code}; msg=${unknownRejected?.msg || unknownRejected?.message || ''}`
    })
    const disabledRejected = await api.post('/wms/business-io-type-rule/create', {
      ...ruleBase,
      businessTypeCode: disabledValue
    }, expectedServiceRejection(/业务出入库类型不存在或已停用/))
    caseRecord.checks.push({
      name: '停用字典值创建映射规则被后端拒绝',
      passed:
        matchesExpectedBusinessRejection(
          disabledRejected,
          expectedServiceRejection(/业务出入库类型不存在或已停用/).expectedBusinessRejection
        ),
      details: `code=${disabledRejected?.code}; msg=${disabledRejected?.msg || disabledRejected?.message || ''}`
    })
    const invalidCoreRejected = await api.post('/wms/business-io-type-rule/create', {
      ...ruleBase,
      coreStockIoType: `NOT_${compactCode(tag)}`
    }, expectedServiceRejection(/核心出入库类型编码无效/))
    caseRecord.checks.push({
      name: '企业自定义核心出入库类型被固定枚举校验拒绝',
      passed:
        matchesExpectedBusinessRejection(
          invalidCoreRejected,
          expectedServiceRejection(/核心出入库类型编码无效/).expectedBusinessRejection
        ),
      details: `code=${invalidCoreRejected?.code}; msg=${invalidCoreRejected?.msg || invalidCoreRejected?.message || ''}`
    })

    ruleId = String(dataOf(await api.postBusiness(
      '/wms/business-io-type-rule/create', ruleBase
    ), 'QC-006 专属映射规则创建'))
    caseRecord.fixtures.push({ kind: 'qc006Rule', id: ruleId, value, token: tag })
    const created = dataOf(await api.getBusiness(
      `/wms/business-io-type-rule/get?id=${encodeURIComponent(ruleId)}`
    ), 'QC-006 专属映射规则详情')
    caseRecord.checks.push({
      name: '映射规则保存字典 label 快照并返回固定核心方向',
      passed:
        created?.businessTypeCode === value &&
        created?.businessTypeName === initialLabel &&
        created?.coreStockIoType === '299' &&
        created?.direction === 'OUT',
      details:
        `ruleId=${ruleId}; name=${created?.businessTypeName}; ` +
        `core=${created?.coreStockIoType}; direction=${created?.direction}`
    })
    const duplicateRejected = await api.post(
      '/wms/business-io-type-rule/create',
      ruleBase,
      expectedServiceRejection(/业务出入库类型编码已存在映射规则/)
    )
    caseRecord.checks.push({
      name: '同一业务类型编码重复创建映射规则被后端拒绝',
      passed:
        matchesExpectedBusinessRejection(
          duplicateRejected,
          expectedServiceRejection(/业务出入库类型编码已存在映射规则/).expectedBusinessRejection
        ),
      details: `code=${duplicateRejected?.code}; msg=${duplicateRejected?.msg || duplicateRejected?.message || ''}`
    })

    dataOf(await api.putBusiness('/system/dict-data/update', {
      ...dictionary,
      label: renamedLabel
    }), 'QC-006 业务类型字典改名')
    const renamedDictionary = dataOf(await api.getBusiness(
      `/system/dict-data/get?id=${encodeURIComponent(dictionaryId)}`
    ), 'QC-006 业务类型字典改名回读')
    const afterRename = dataOf(await api.getBusiness(
      `/wms/business-io-type-rule/get?id=${encodeURIComponent(ruleId)}`
    ), 'QC-006 改名后映射规则详情')
    caseRecord.checks.push({
      name: '字典改名后历史映射规则名称快照不回溯',
      passed:
        renamedDictionary?.label === renamedLabel &&
        afterRename?.businessTypeName === initialLabel,
      details: `dictionaryLabel=${renamedDictionary?.label}; ruleSnapshot=${afterRename?.businessTypeName}`
    })

    const stockBody = (billNo) => ({
      billNo,
      billDate: new Date().toISOString().slice(0, 10),
      subject: `QC-006 ${tag}`,
      remark: `${WMS_FIXTURE_MARK} ${tag}`,
      stockIoType: '106',
      businessTypeCode: value,
      isAuto: 0,
      stkIoEntryList: [{
        materialId: String(fixture.material.id),
        unitId: String(fixture.unit.id),
        qty: 1,
        cost: 1,
        warehouseId: String(fixture.warehouse.id),
        wareAreaId: String(fixture.area.id),
        wareLocationId: String(fixture.location.id),
        batchNo: `${tag}-BATCH`,
        entryNo: 1,
        stockIoType: '106',
        stockIoDirection: '1',
        isQc: 0,
        settleQty: 1
      }],
      stkIoDistributionList: [],
      stkIoBomList: []
    })
    const mismatchRejected = await api.post(
      '/mes/stkIo/add/save',
      stockBody(`QC6-MISMATCH-${compactCode(tag)}`),
      expectedServiceRejection(/库存方向与当前单据不一致/)
    )
    caseRecord.checks.push({
      name: '启用映射规则将核心类型收敛为299并拒绝106方向不一致',
      passed:
        matchesExpectedBusinessRejection(
          mismatchRejected,
          expectedServiceRejection(/库存方向与当前单据不一致/).expectedBusinessRejection
        ),
      details: `code=${mismatchRejected?.code}; msg=${mismatchRejected?.msg || mismatchRejected?.message || ''}`
    })

    const disabledRule = {
      ...ruleBase,
      id: String(ruleId),
      active: false,
      remark: `${ruleBase.remark} disabled`
    }
    dataOf(await api.putBusiness('/wms/business-io-type-rule/update', disabledRule),
      'QC-006 映射规则停用')
    const disabledDetail = dataOf(await api.getBusiness(
      `/wms/business-io-type-rule/get?id=${encodeURIComponent(ruleId)}`
    ), 'QC-006 映射规则停用详情')
    const billNo = `QC6-DISABLED-${compactCode(tag)}`
    dataOf(await api.postBusiness('/mes/stkIo/add/save', stockBody(billNo)),
      'QC-006 停用规则后保存草稿')
    const draftRows = pageRowsFromResponse(await api.getBusiness(
      `/mes/stkIo/list?pageNo=1&pageSize=100&billNo=${encodeURIComponent(billNo)}`
    ))
    draftId = draftRows.find((row) => String(row?.billNo) === billNo)?.id
    const draft = draftId
      ? dataOf(await api.getBusiness(`/mes/stkIo/queryById?id=${encodeURIComponent(draftId)}`),
          'QC-006 停用规则后草稿详情')
      : null
    caseRecord.checks.push({
      name: '停用映射规则不参与校验且保留表单核心类型',
      passed:
        Number(disabledDetail?.active) === 0 &&
        String(draft?.businessTypeCode) === value &&
        String(draft?.businessTypeName) === renamedLabel &&
        String(draft?.stockIoType) === '106',
      details:
        `ruleActive=${disabledDetail?.active}; draftId=${draftId || ''}; ` +
        `name=${draft?.businessTypeName}; stockIoType=${draft?.stockIoType}`
    })
    caseRecord.evidence.push(
      '专属字典与映射规则验证未知/停用值拒绝、固定核心类型、名称快照、租户唯一和停用规则退出写侧'
    )
    return { covered: true }
  } finally {
    if (draftId) {
      await rawCall(() => api.delete(`/mes/stkIo/delete?id=${encodeURIComponent(draftId)}`))
    }
    if (ruleId) {
      await rawCall(() => api.delete(
        `/wms/business-io-type-rule/delete?id=${encodeURIComponent(ruleId)}`))
    }
    for (const id of [dictionaryId, disabledDictionaryId].filter(Boolean)) {
      await rawCall(() => api.delete(`/system/dict-data/delete?id=${encodeURIComponent(id)}`))
    }
    await cleanupWmsFixtures(withCleanupRejectionContracts(api), caseRecord)
  }
}

const runQc007WriteSide = async (api, caseRecord) => {
  if (!isWmsWriteEnabled()) {
    addPartial(caseRecord, '未启用 CFOR_E2E_WRITE_FIXTURES=true，未创建运输车辆写侧夹具。')
    return { covered: false }
  }
  assertLocalWmsWriteTarget()
  const employees = rowsOf(await api.getBusiness(
    '/hrm/employee/simple-page?pageNo=1&pageSize=100'
  ), 'QC-007 HRM 员工')
  const employee = employees.find((row) => String(row?.id || '').trim() && String(row?.name || '').trim())
  const materials = rowsOf(await api.getBusiness(
    '/mes/basMaterial/list?pageNo=1&pageSize=100&isEnabled=1'
  ), 'QC-007 可用实物存货')
  const material = materials.find((row) =>
    String(row?.id || '').trim() && String(row?.unitId || '').trim() &&
    row?.inventoryNature === 'STOCK' && row?.saled === 'Y'
  )
  const units = rowsOf(await api.getBusiness('/mes/basUnit/list/enabled'), 'QC-007 计量单位')
  const unit = units.find((row) => String(row?.id) === String(material?.unitId))
  if (!employee) throw new Error('BLOCKED: QC-007 没有带姓名的有效 HRM 员工')
  if (!material) throw new Error('BLOCKED: QC-007 没有启用、可销售且具主单位的实物存货')
  if (!unit) throw new Error('BLOCKED: QC-007 专属发货所需物料主单位未在启用单位中')
  await verifyWmsTransportClosure({ api, caseRecord, employee, material, unitId: unit.id })
  return { covered: true, employeeId: String(employee.id), materialId: String(material.id), unitId: String(unit.id) }
}

const qc007CatalogEvidence = Object.freeze(Object.fromEntries(
  wmsQc007Mapping.assertions.map((item, index) => [index, item.checks])
))

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const warehousePageRequest = (response, pathname, warehouseId) => {
  try {
    const url = new URL(response.url())
    return url.pathname.endsWith(pathname) && url.searchParams.get('houseId') === String(warehouseId)
  } catch {
    return false
  }
}

const validateWarehousePageResponse = async (response, pathname, warehouseId) => {
  let payload
  try {
    payload = await response.json()
  } catch {
    return { passed: false, details: `${pathname}: 响应不是可解析 JSON` }
  }
  if (!response.ok() || !isBusinessSuccess(payload)) {
    return {
      passed: false,
      details: `${pathname}: HTTP=${response.status()}; code=${payload?.code}; message=${payload?.msg || payload?.message || ''}`
    }
  }
  const data = payload?.data
  const records = Array.isArray(data?.records) ? data.records : Array.isArray(data?.list) ? data.list : null
  const total = data?.total
  const scoped = Array.isArray(records) && records.length > 0 &&
    records.every((row) => String(row?.houseId) === String(warehouseId))
  const totalMatches = Number.isFinite(Number(total)) && Number(total) === records?.length
  return {
    passed: Boolean(scoped && totalMatches),
    details: `${pathname}: total=${total}; rows=${records?.length ?? 'invalid'}; ` +
      `scoped=${scoped}; totalMatches=${totalMatches}`
  }
}

const captureWarehousePageEvidence = async ({
  page, route, warehouse, openRoute, saveScreenshot, outputDir, record, caseRecord, screenshotName
}) => {
  await openRoute(page, route, { readySelector: 'input[placeholder="请输入仓库名称"]' })
  const search = page.locator('input[placeholder="请输入仓库名称"]').first()
  const warehouseName = String(warehouse.name)
  const exactName = new RegExp(`^${escapeRegExp(warehouseName)}$`)
  let passed = false
  let details = ''
  try {
    if ((await search.count()) !== 1) {
      throw new Error('仓库树搜索框不存在或不唯一')
    }
    await search.fill(warehouseName)
    const labels = page.locator('.el-tree-node__label:visible').filter({ hasText: exactName })
    if ((await labels.count()) !== 1) {
      throw new Error(`专属仓库树节点不唯一：name=${warehouseName}; count=${await labels.count()}`)
    }
    const areaResponse = page.waitForResponse((response) =>
      warehousePageRequest(response, '/mes/wmsHouseArea/list', warehouse.id))
    const locationResponse = page.waitForResponse((response) =>
      warehousePageRequest(response, '/mes/wms-house-location/page', warehouse.id))
    const [area, location] = await Promise.all([
      areaResponse,
      locationResponse,
      (async () => {
        await labels.first().click()
        const selected = page.locator('.el-tree-node.is-current .el-tree-node__label:visible')
          .filter({ hasText: exactName })
        if ((await selected.count()) !== 1) {
          throw new Error(`专属仓库树节点未进入选中态：name=${warehouseName}`)
        }
      })()
    ])
    const [areaResult, locationResult] = await Promise.all([
      validateWarehousePageResponse(area, '/mes/wmsHouseArea/list', warehouse.id),
      validateWarehousePageResponse(location, '/mes/wms-house-location/page', warehouse.id)
    ])
    passed = areaResult.passed && locationResult.passed
    details = `warehouse=${warehouse.id}; selected=true; ${areaResult.details}; ${locationResult.details}`
  } catch (error) {
    details = `warehouse=${warehouse.id}; ${error.message}`
  }
  caseRecord.checks.push({
    name: '写侧夹具完成后仓库档案页面按已选专属仓库过滤库区库位',
    passed,
    details: `${route}; ${details}`
  })
  await saveScreenshot(page, outputDir, screenshotName, record)
  caseRecord.evidence.push(
    passed
      ? `专属仓库已选中后库区/库位按 houseId 真实过滤并截图：${warehouse.name}`
      : `仓库档案页面过滤证据失败，截图仅供排查，不作为过滤通过证据：${warehouse.name}; ${details}`
  )
  return passed
}

export const __internal = {
  rawCall,
  isBusinessRejection,
  runQc004WriteSide,
  runQc006WriteSide,
  runQc007WriteSide,
  runQc008WriteSide,
  expectedCleanupRejection,
  withCleanupRejectionContracts,
  captureWarehousePageEvidence,
  validateWarehousePageResponse,
  warehousePageRequest,
  qc009Rejection,
  qc009DictionaryBody,
  runQc009WriteSide
}

export const runCase = async ({ caseId, page, record, caseRecord, outputDir, check }, dependencies = {}) => {
  const login = dependencies.login || browserLogin
  const createApiClient = dependencies.createApiClient || apiClient
  const openRoute = dependencies.openRoute || browserOpenRoute
  const saveScreenshot = dependencies.saveScreenshot || browserScreenshot
  caseRecord.notes.push(
    '案例已锁定 mes_stk_inventory 唯一实物事实源、质检隔离量、ATP、库存守恒、幂等和事务回滚。'
  )

  if (
    WMS_QC_CLOSURE_CASES.includes(caseId) &&
    (dependencies.runWmsQcClosure === true ||
      process.env.CFOR_E2E_ENABLE_WMS_QC_CLOSURE === 'true')
  ) {
    const token = await login(page)
    const api = createApiClient({ token, record })
    return runWmsQcClosure({
      caseId,
      api,
      page,
      record,
      caseRecord,
      outputDir,
      dependencies: {
        ...dependencies,
        openRoute,
        saveScreenshot
      }
    })
  }

  if (caseId === 'WMS-QC-001') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    if (!isWmsWriteEnabled()) {
      addPartial(caseRecord, '未启用 CFOR_E2E_WRITE_FIXTURES=true，未创建质检入库夹具。')
      return { token, api, partial: true }
    }
    const fixture = await prepareWmsFixture(api, caseRecord, 1)
    try {
      return await withManualOqcScenario(api, caseRecord, async () => {
        const nonQcMaterial = await createMaterialFixture(
          api, caseRecord, `${fixture.token}-NONQC`, fixture.unit.id
        )
        const nonQcReceipt = await createStockIoFixture(
          api, caseRecord, fixture, nonQcMaterial, fixture.unit.id, {
            stockIoType: '101',
            quantity: 4,
            isQc: 0,
            batchNo: `${fixture.token}-NONQC-BATCH`
          }
        )
        const nonQcInventory = await inventorySnapshot(api, fixture, nonQcMaterial.id)
        const nonQcRow = nonQcInventory.find((item) =>
          String(item.materialId) === String(nonQcMaterial.id))
        const nonQcInspections = pageRowsFromResponse(await api.getBusiness(
          `/mes/quality/qualityInspection/list/dictText?pageNo=1&pageSize=100` +
          `&srcBillType=${encodeURIComponent('StkIo:101')}` +
          `&srcBillId=${encodeURIComponent(nonQcReceipt.id)}`
        ))
        caseRecord.checks.push({
          name: '非质检物料真实 101 入库后不生成入库检且直接可用',
          passed:
            nonQcReceipt.approved &&
            Boolean(nonQcRow) &&
            quantity(nonQcRow.availableQty) >= 4 &&
            quantity(nonQcRow.holdQty) === 0 &&
            nonQcInspections.every((row) => String(row?.srcBillId) !== String(nonQcReceipt.id)),
          details:
            `receiptId=${nonQcReceipt.id}; materialId=${nonQcMaterial.id}; ` +
            `available=${nonQcRow?.availableQty}; hold=${nonQcRow?.holdQty}; ` +
            `inspections=${nonQcInspections.length}`
        })

        const receipt = await createStockIoFixture(api, caseRecord, fixture, fixture.material, fixture.unit.id, {
          stockIoType: '101', quantity: 10, isQc: 1
        })
        if (!receipt.approved) {
          addPartial(caseRecord, '101 质检入库审批未完成，未伪造待检/放行结果。')
          return { token, api, partial: true }
        }
        const inventory = await inventorySnapshot(api, fixture, fixture.material.id)
        const row = inventory.find((item) => String(item.materialId) === String(fixture.material.id))
        const isolated =
          Boolean(row) &&
          (quantity(row.holdQty) > 0 || quantity(row.pendingPutawayQty) > 0) &&
          quantity(row.availableQty) === 0
        caseRecord.checks.push({
          name: '质检入库审核后 mes_stk_inventory 保留专属物料事实',
          passed: Boolean(row),
          details: row ? `qty=${row.qty}; available=${row.availableQty}; hold=${row.holdQty}; pending=${row.pendingPutawayQty}; quality=${row.qualityStatus}` : '无库存行'
        })
        caseRecord.checks.push({
          name: '质检入库未放行时库存具备隔离/待上架字段事实',
          passed: isolated,
          details: row ? `hold=${row.holdQty}; pending=${row.pendingPutawayQty}; quality=${row.qualityStatus}` : '无库存行'
        })
        caseRecord.checks.push({
          name: '质检物料真实 101 入库后存在待检隔离事实',
          passed:
            Boolean(row) &&
            (quantity(row.holdQty) > 0 || quantity(row.pendingPutawayQty) > 0) &&
            quantity(row.availableQty) === 0,
          details:
            `receiptId=${receipt.id}; materialId=${fixture.material.id}; ` +
            `available=${row?.availableQty}; hold=${row?.holdQty}; ` +
            `pending=${row?.pendingPutawayQty}; quality=${row?.qualityStatus}`
        })

        const stockEntries = dataOf(
          await api.getBusiness(`/mes/stkIo/queryEntryByMainId?id=${encodeURIComponent(receipt.id)}`),
          'WMS-QC-001 质检入库明细回读'
        )
        const stockEntry = Array.isArray(stockEntries)
          ? stockEntries.find((entry) => String(entry?.materialId) === String(fixture.material.id))
          : null
        caseRecord.checks.push({
          name: '正式质检单可定位来源入库明细',
          passed: Boolean(stockEntry?.id),
          details: `receiptId=${receipt.id}; entryId=${stockEntry?.id || ''}`
        })
        if (!stockEntry?.id) throw new Error('WMS-QC-001 来源入库明细缺失，无法执行正式质检放行')

        const inspection = await createInspection(api, caseRecord, {
          type: '101',
          action: 'submit',
          materialId: fixture.material.id,
          unitId: fixture.unit.id,
          quantity: 10,
          srcBillType: 'StkIo:101',
          srcBillId: receipt.id,
          srcEntryId: stockEntry.id,
          token: `${fixture.token}-QC001`
        })
        const beforeRelease = await inventorySnapshot(api, fixture, fixture.material.id)
        const beforeRow = beforeRelease.find((item) => String(item.materialId) === String(fixture.material.id))
        const audit = await checkInspection(api, caseRecord, inspection.inspectionId)
        const afterRelease = await inventorySnapshot(api, fixture, fixture.material.id)
        const afterRow = afterRelease.find((item) => String(item.materialId) === String(fixture.material.id))
        const beforeHold = quantity(beforeRow?.holdQty)
        const afterHold = quantity(afterRow?.holdQty)
        const beforeAvailable = quantity(beforeRow?.availableQty)
        const afterAvailable = quantity(afterRow?.availableQty)
        const releasedQty = beforeHold - afterHold
        const receivedQty = quantity(stockEntry.qty)
        const approved = Number(audit.detail?.isEffective || 0) === 1
        caseRecord.checks.push({
          name: '正式质检放行后 holdQty 减少且 availableQty 等量增加',
          passed: approved &&
            releasedQty > 0 &&
            Math.abs(releasedQty - (afterAvailable - beforeAvailable)) < 0.000001 &&
            Math.abs(releasedQty - receivedQty) < 0.000001,
          details: `inspection=${inspection.inspectionId}; beforeHold=${beforeHold}; afterHold=${afterHold}; ` +
            `beforeAvailable=${beforeAvailable}; afterAvailable=${afterAvailable}; released=${releasedQty}; receiptQty=${receivedQty}`
        })
        caseRecord.checks.push({
          name: '质检放行前后 mes_stk_inventory 总量守恒',
          passed: inventoryConserved(beforeRow) && inventoryConserved(afterRow) &&
            Math.abs(quantity(beforeRow?.qty) - quantity(afterRow?.qty)) < 0.000001,
          details: `beforeQty=${beforeRow?.qty}; afterQty=${afterRow?.qty}; ` +
            `beforeAvailable=${beforeRow?.availableQty}; afterAvailable=${afterRow?.availableQty}; ` +
            `beforeHold=${beforeRow?.holdQty}; afterHold=${afterRow?.holdQty}`
        })
        caseRecord.checks.push({
          name: '正式质检放行后 qualityStatus 为合格状态',
          passed: approved && String(afterRow?.qualityStatus || '') === '1',
          details: `qualityStatus=${afterRow?.qualityStatus || ''}`
        })

        const repeated = await rawCall((options) => api.put('/mes/quality/qualityInspection/check', {
          id: String(inspection.inspectionId),
          approvalResultType: '1',
          approvalRemark: 'E2E quality write-side idempotency probe'
        }, options), {
          expectedBusinessRejection: {
            code: 500,
            message: /单据不能做该操作/,
            allowServiceCode: true
          }
        })
        const afterRepeat = await inventorySnapshot(api, fixture, fixture.material.id)
        const repeatRow = afterRepeat.find((item) => String(item.materialId) === String(fixture.material.id))
        caseRecord.checks.push({
          name: '重复审核质检单不产生第二次库存放行',
          passed: (!repeated.ok || repeated.businessRejection) &&
            Math.abs(quantity(repeatRow?.availableQty) - afterAvailable) < 0.000001 &&
            Math.abs(quantity(repeatRow?.holdQty) - afterHold) < 0.000001,
          details: `repeatCode=${repeated.code}; repeatMsg=${repeated.msg || repeated.message || ''}; ` +
            `available=${repeatRow?.availableQty}; hold=${repeatRow?.holdQty}`
        })
        caseRecord.evidence.push(
          `正式质检单 ${inspection.inspectionId} 从 StkIo:101/${stockEntry.id} 放行，` +
          `库存 ${beforeHold} hold -> ${afterHold} hold、${beforeAvailable} available -> ${afterAvailable} available，总量守恒且重复审核无二次迁移`
        )
        wmsCatalogEvidence('WMS-QC-001', caseRecord, {
          0: [
            '质检物料真实 101 入库后存在待检隔离事实',
            '非质检物料真实 101 入库后不生成入库检且直接可用'
          ],
          1: [
            '质检物料真实 101 入库后存在待检隔离事实',
            '质检入库未放行时库存具备隔离/待上架字段事实'
          ],
          2: [
            '正式质检放行后 holdQty 减少且 availableQty 等量增加',
            '正式质检放行后 qualityStatus 为合格状态'
          ],
          3: [
            '质检放行前后 mes_stk_inventory 总量守恒',
            '重复审核质检单不产生第二次库存放行'
          ]
        })
        await browserOpenRoute(page, '/quality/pendingInspect').catch(() => {})
        await browserScreenshot(page, outputDir, 'wms-qc-001-pending-inspect', record).catch(() => {})
        caseRecord.evidence.push('专属 101 质检入库、正式质检单审核、mes_stk_inventory 放行回读和页面截图')
        return {
          token,
          api,
          partial: false,
          acceptanceComplete: caseRecord.catalogAssertions.every((item) => item.status === 'VERIFIED') &&
            caseRecord.checks.every((check) => check.passed !== false)
        }
      }, dependencies)
    } finally {
      await cleanupWmsFixtures(withCleanupRejectionContracts(api), caseRecord)
    }
  }
  caseRecord.notes.push(
    'WMS-QC-004 锁定库区/库位层级归属、租户+仓库编码唯一，以及有库存、未完成装箱任务或' +
      '未完成出入库单时禁止删除或调整库位归属。'
  )
  caseRecord.notes.push(
    'WMS-QC-005 锁定库存期初的 106 单据事实源：跨导入按上线基准日和完整库存维度判重，' +
      '已生效或已进入正式出入库后禁止直接编辑，修正走受控链路。'
  )
  caseRecord.notes.push(
    'WMS-QC-006 锁定业务出入库类型「字典主档 + 领域规则表」双层模型：' +
      '企业显示类型来自字典 wms_business_io_type，核心库存方向由固定枚举决定。'
  )
  caseRecord.notes.push(
    'WMS-QC-007 锁定运输车辆司机引用 HRM 员工、承运商引用统一客商承运商角色，' +
      '车牌在租户内唯一。'
  )
  caseRecord.notes.push(
    'WMS-QC-008 锁定仓库主档显式控制库区/库位启用，禁用库区时不允许保留库位。'
  )
  caseRecord.notes.push(
    'WMS-QC-009 锁定企业自定义出入库类型可直接新增：字典类型无需先配置映射规则，' +
      '未配置规则时仅快照企业类型名称，核心出入库类型与方向沿用表单选择，不改变底层库存方向。'
  )
  caseRecord.notes.push(
    'WMS-QC-010 锁定旧 ERP 仓库表退役为只读兼容视图：读侧仍可查询，写侧统一返回 1030400002。'
  )

  if (['WMS-QC-002', 'WMS-QC-003', 'WMS-QC-004'].includes(caseId)) {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const permissions = await api.getBusiness('/system/auth/get-permission-info')
    const menus = permissions?.data?.menus
    if (!Array.isArray(menus)) throw new Error('权限信息缺少菜单树')
    const inventoryResponse = await api.getBusiness('/mes/stkInventory/list/dictText?pageNo=1&pageSize=100')
    const inventory = recordList(caseRecord, 'WMS 库存分页响应结构可解析', strictList(inventoryResponse), 'mes_stk_inventory')
    const warehouseResponse = await api.getBusiness('/mes/wmsWareHouse/allTree')
    const warehouses = Array.isArray(warehouseResponse?.data) ? warehouseResponse.data : []
    caseRecord.checks.push({
      name: 'WMS 仓库树响应结构可解析',
      passed: Array.isArray(warehouseResponse?.data),
      details: `warehouses=${warehouses.length}`
    })

    if (caseId === 'WMS-QC-002') {
      const orders = recordList(
        caseRecord,
        '销售订单分页响应结构可解析',
        strictList(await api.getBusiness('/erp/sale-order/page?pageNo=1&pageSize=100&status=20')),
        '审核通过订单前置'
      )
      if (!orders.some((row) => row.status === 20)) addPartial(caseRecord, '当前查询没有审核通过(status=20)的销售订单。')
      const notices = recordList(
        caseRecord,
        '发货通知只读分页响应结构可解析',
        strictList(await api.getBusiness('/mes/wms/sales-notice/page?pageNo=1&pageSize=100')),
        'wms_sales_notice'
      )
      if (inventory.length) caseRecord.checks.push({
        name: '库存数量字段为有限数值',
        passed: inventory.every((row) => finiteQuantity(row.qty)),
        details: `inventory=${inventory.length}`
      })
      addPartial(
        caseRecord,
        `未执行销售订单审核、预留/在途计算、按行出库、出库质检阻断、库存守恒及冲销；当前只读取库存=${inventory.length}、发货通知=${notices.length}，空集不视为业务通过。`
      )
      if (!inventory.some((row) => finiteQuantity(row.lockQty) && Number(row.lockQty) > 0)) {
        addPartial(caseRecord, '当前库存样本没有正数 lockQty 预留事实，不能推断 ATP/预留扣减正确。')
      }
    } else if (caseId === 'WMS-QC-003') {
      caseRecord.checks.push({
        name: '当前登录用户权限信息可读取',
        passed: Array.isArray(menus),
        details: `menus=${menus.length}`
      })
      addPartial(
        caseRecord,
        '未使用第二租户/低权限身份，也未执行重复审核、跨租户访问、事务回滚或流水余额对账；不能用当前单一身份推断隔离和幂等通过。'
      )
    } else {
      const areas = recordList(
        caseRecord,
        '库区分页响应结构可解析',
        strictList(await api.getBusiness('/mes/wmsHouseArea/list?pageNo=1&pageSize=100')),
        'mes_wms_house_area'
      )
      const locations = recordList(
        caseRecord,
        '库位分页响应结构可解析',
        strictList(await api.getBusiness('/mes/wms-house-location/page?pageNo=1&pageSize=100')),
        'mes_wms_house_location'
      )
      if (areas.length) caseRecord.checks.push({
        name: '当前库区分页样本仓库内编码不重复（非全租户唯一性验收）',
        passed: duplicateCodes(areas, 'areaCode').length === 0,
        details: `sampleRows=${areas.length}`
      })
      if (locations.length) caseRecord.checks.push({
        name: '当前库位分页样本仓库内编码不重复（非全租户唯一性验收）',
        passed: duplicateCodes(locations, 'locationCode').length === 0,
        details: `sampleRows=${locations.length}`
      })
      // 历史测试或手动操作可能留下引用已删除库区的孤儿库位；优先取能解析到库区的有效样本，
      // 并把跳过的孤儿登记为备注（产品侧已补「库区下有库位禁止删除」保护，防止再产生孤儿）。
      const orphanLocations = []
      let location
      let area
      for (const candidate of locations.filter((row) => row.areaId && row.houseId)) {
        const resolved = await rawCall(
          (options) => api.get(`/mes/wmsHouseArea/queryById?id=${encodeURIComponent(candidate.areaId)}`, options),
          qc004Rejections.missingArea
        )
        if (resolved.data) {
          location = candidate
          area = resolved.data
          break
        }
        if (resolved.expectedBusinessRejectionMatched) {
          orphanLocations.push(`${candidate.id}->${candidate.areaId}`)
          continue
        }
        throw new Error(`库位归属库区回读失败：${candidate.id}->${candidate.areaId}`)
      }
      if (location) {
        caseRecord.checks.push({
          name: '只读库位样本的库区归属同一仓库',
          passed: String(area?.houseId) === String(location.houseId),
          details: `location=${location.id}; area=${location.areaId}; warehouse=${location.houseId}`
        })
        const warehouse = (await api.getBusiness(`/mes/wmsWareHouse/queryById?id=${encodeURIComponent(location.houseId)}`)).data
        if (warehouse?.areaEnabled !== true || warehouse?.locationEnabled !== true) {
          addPartial(caseRecord, `库位样本仓库=${location.houseId}未同时显式启用库区/库位，缺少启用测试仓库前置。`)
        }
      } else addPartial(caseRecord, '没有同时包含 houseId/areaId 的有效库位样本，层级关联未验证。')
      if (orphanLocations.length) {
        caseRecord.notes.push(
          `跳过 ${orphanLocations.length} 条引用不存在库区的历史孤儿库位：${orphanLocations.slice(0, 5).join(', ')}`)
      }
      if (areas.length && locations.length) caseRecord.checks.push({
        name: '库区和库位引用字段可进行静态关联检查',
        passed: areas.every((row) => row?.houseId !== undefined) &&
          locations.every((row) => row?.houseId !== undefined),
        details: `areas=${areas.length}, locations=${locations.length}`
      })
    }

    const componentCandidates = caseId === 'WMS-QC-004'
      ? ['base/warehouseConfig/archives/index', 'base/warehouseConfig/archives']
      : ['wms/salesNotice/index', 'wms/salesNotice']
    const route = menuRoute(menus, componentCandidates)
    if (route) {
      await openRoute(page, route, { readySelector: caseId === 'WMS-QC-004'
        ? 'input[placeholder="请输入仓库名称"]' : 'input[placeholder="销售订单编号"]' })
      caseRecord.checks.push({
        name: '根据真实权限菜单打开对应设置页',
        passed: new URL(page.url()).pathname === route,
        details: `${route} -> ${page.url()}`
      })
      await saveScreenshot(page, outputDir, `${caseId.toLowerCase()}-readonly-gate`, record)
      caseRecord.evidence.push(`真实权限菜单解析路由 ${route}、只读接口响应和页面截图`)
    } else {
      addPartial(caseRecord, '当前账号权限菜单未暴露目标页面，未猜测旧路径。')
      if (caseId === 'WMS-QC-002') {
        wmsCatalogEvidence('WMS-QC-002', caseRecord, {
          0: { gap: '目标页面不可达，未通过真实订单和 WMS 库存契约验证 ATP 来源' },
          1: { gap: '未构造预留和在途库存，ATP 分量未验证' },
          2: { gap: '未执行按行部分出库' },
          3: { gap: '未执行出库检不合格阻断' },
          4: { gap: '未执行发运及库存守恒' }
        })
      } else if (caseId === 'WMS-QC-003') {
        wmsCatalogEvidence('WMS-QC-003', caseRecord, {
          0: { gap: '目标页面不可达，第二租户身份未安全构造' },
          1: { gap: '目标页面不可达，低权限账号未安全构造' },
          2: { gap: '未执行重复审核写侧' },
          3: { gap: '未执行多行事务回滚写侧' },
          4: { gap: '未完成不可变流水与余额一致性对账' }
        })
      } else {
        wmsCatalogEvidence('WMS-QC-004', caseRecord, {
          0: { gap: '目标页面不可达，专属仓库库区唯一性未验证' },
          1: { gap: '目标页面不可达，专属仓库库位唯一性未验证' },
          2: { gap: '目标页面不可达，库位层级和启用归属未验证' },
          3: { gap: '目标页面不可达，库存/装箱/未完成单据引用保护未验证' },
          4: { gap: '目标页面不可达，未启用库区库位反例未验证' }
        })
      }
      return { token, api, partial: true }
    }
    if (caseId === 'WMS-QC-004') {
      try {
        const write = await runQc004WriteSide(api, caseRecord)
        if (write.referenceFixture) {
          const foreignSourceBefore = await api.getBusiness(
            `/mes/wms-house-location/get?id=${write.referenceFixture.location.id}`
          )
          await verifyWmsTenantIsolation({
            context: { page, record, check }, api, caseRecord,
            tenant1Fixture: write.referenceFixture
          })
          const foreignSourceAfter = await api.getBusiness(
            `/mes/wms-house-location/get?id=${write.referenceFixture.location.id}`
          )
          caseRecord.checks.push({
            name: '跨租户读取删除更新拒绝后源租户完整库位原值不变',
            passed: JSON.stringify(foreignSourceBefore.data) === JSON.stringify(foreignSourceAfter.data),
            details: `location=${write.referenceFixture.location.id}`
          })
        }
        if (write.pageWarehouse) {
          await captureWarehousePageEvidence({
            page, route, warehouse: write.pageWarehouse, openRoute, saveScreenshot,
            outputDir, record, caseRecord, screenshotName: 'wms-qc-004-after-write'
          })
        }
        wmsCatalogEvidence('WMS-QC-004', caseRecord, {
          0: write.covered ? ['同一仓库重复库区编码被后端拒绝'] : { gap: '专属仓库未完成，库区唯一性未验证' },
          1: write.covered ? ['同一仓库重复库位编码被后端拒绝'] : { gap: '专属仓库未完成，库位唯一性未验证' },
          2: write.covered
            ? [
                '库位所属库区与仓库不一致被后端拒绝',
                '未启用库区的仓库创建库区被后端拒绝',
                '未启用库位的仓库创建库位被后端拒绝'
              ]
            : { gap: '专属仓库未完成，库位层级和启用归属未验证' },
          3: {
            checks: [
              '库位存在未完成出入库单时删除被后端拒绝',
              '库位存在未完成出入库单时调整仓库/库区归属被后端拒绝',
              '库存占用：正式期初生效且精确库位库存为一',
              '库存占用：删除领域拒绝且库位原值不变',
              '库存占用：移动领域拒绝且库位原值不变',
              '装箱占用：独立空库存库位绑定未完成装箱草稿',
              '装箱占用：删除领域拒绝且库位原值不变',
              '装箱占用：移动领域拒绝且库位原值不变'
            ]
          },
          4: write.covered
            ? [
                '未启用库区的仓库创建库区被后端拒绝',
                '未启用库位的仓库创建库位被后端拒绝'
              ]
            : { gap: '专属仓库未完成，未启用库区库位反例未验证' },
          audit: {
            0: [
              '库存占用：正式期初生效且精确库位库存为一',
              '库存占用：删除领域拒绝且库位原值不变',
              '库存占用：移动领域拒绝且库位原值不变',
              '装箱占用：独立空库存库位绑定未完成装箱草稿',
              '装箱占用：删除领域拒绝且库位原值不变',
              '装箱占用：移动领域拒绝且库位原值不变'
            ],
            1: [
              '同编码跨仓库区库位可分别建档且归属隔离',
              '第二租户同编码仓库库区库位可创建并回读归属隔离',
              '第二租户真实登录读取 tenant1 指定库位不可见',
              '第二租户删除 tenant1 指定库位返回精确 NOT_EXISTS 领域错误',
              '第二租户更新 tenant1 指定库位返回精确 NOT_EXISTS 领域错误',
              '跨租户读取删除更新拒绝后源租户完整库位原值不变'
            ],
            2: [
              '空库位跨仓库区归属调整精确领域拒绝且原值不变',
              '未完成出入库占用：删除领域拒绝且库位原值不变',
              '未完成出入库占用：移动领域拒绝且库位原值不变',
              '库存占用：删除领域拒绝且库位原值不变',
              '库存占用：移动领域拒绝且库位原值不变',
              '装箱占用：删除领域拒绝且库位原值不变',
              '装箱占用：移动领域拒绝且库位原值不变'
            ]
          }
        })
        return { token, api, partial: !write.covered || !caseRecord.passCandidate }
      } finally {
        await cleanupWmsFixtures(withCleanupRejectionContracts(api), caseRecord)
      }
    }
    if (caseId === 'WMS-QC-002') {
      wmsCatalogEvidence('WMS-QC-002', caseRecord, {
        0: { gap: '只读取现有库存/发货通知，未从真实销售订单核验 WMS ATP 返回' },
        1: { gap: '当前样本未构造正数 lockQty 与调拨在途，无法证明 ATP 扣预留并计入在途' },
        2: { gap: '未执行按行部分发货或库存不足转生产' },
        3: { gap: '未触发出库检并验证不合格阻断发货完成' },
        4: { gap: '未执行发运和反冲，库存守恒未验证' }
      })
    } else {
      wmsCatalogEvidence('WMS-QC-003', caseRecord, {
        0: { gap: '未安全构造第二租户，跨租户读写隔离未验证' },
        1: { gap: '未安全构造低权限账号，无权限业务拒绝未验证' },
        2: { gap: '未执行重复审核写侧，幂等未验证' },
        3: { gap: '未构造多行失败事务，整体回滚未验证' },
        4: { gap: '未完成不可变流水与库存余额一致性对账' }
      })
    }
    return { token, api, partial: true }
  }

  if (caseId === 'WMS-QC-006') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const [rulePage, coreTypes] = await Promise.all([
      api.getBusiness('/wms/business-io-type-rule/page?pageNo=1&pageSize=100'),
      api.getBusiness('/wms/business-io-type-rule/core-types')
    ])
    const rulesParsed = strictList(rulePage)
    const rules = rulesParsed.rows
    recordList(caseRecord, '业务类型映射分页响应结构可解析', rulesParsed, '规则只读查询')
    const dict = recordList(caseRecord, '业务类型字典分页响应结构可解析',
      strictList(await api.getBusiness('/system/dict-data/page?pageNo=1&pageSize=100&dictType=wms_business_io_type')),
      'wms_business_io_type')
    if (!dict.length) addPartial(caseRecord, '业务类型字典查询为空，字典来源及名称快照未验证。')
    const coreParsed = strictList(coreTypes)
    const coreOptions = coreParsed.rows
    const coreCodes = new Set(coreOptions.map((item) => item?.code).filter(Boolean))
    if (rules.length) caseRecord.checks.push({
      name: '业务出入库类型分页返回字典映射规则',
      passed:
        rulesParsed.valid &&
        rules.every((row) => row?.businessTypeCode && coreCodes.has(row?.coreStockIoType) &&
          coreDirections[row.coreStockIoType] === row.direction),
      details: `rules=${rules.length}, coreTypes=${coreOptions.length}`
    })
    caseRecord.checks.push({
      name: '核心出入库类型只返回固定库存方向选项',
      passed: coreParsed.valid && coreOptions.length === Object.keys(coreDirections).length &&
        new Set(coreOptions.map((item) => item.code)).size === coreOptions.length &&
        coreOptions.every((item) => coreDirections[item.code] === item.direction),
      details: `coreTypes=${coreOptions.length}`
    })

    const permissions = await api.getBusiness('/system/auth/get-permission-info')
    const route = menuRoute(permissions?.data?.menus, [
      'wms/settings/businessIoTypeRule/index',
      'wms/settings/businessIoTypeRule'
    ])
    if (!route) {
      addPartial(caseRecord, '权限菜单未找到业务出入库类型页面，未使用旧路径代替。')
      wmsCatalogEvidence('WMS-QC-006', caseRecord, {
        0: { gap: '未进入业务类型设置页，未知/停用值写侧未验证' },
        1: ['核心出入库类型只返回固定库存方向选项'],
        2: { gap: '未创建专属规则，字典改名快照未验证' },
        3: { gap: '未创建专属规则，租户唯一和停用规则退出写侧未验证' }
      })
      return { token, api, partial: true }
    }
    await openRoute(page, route, { readySelector: '.el-form-item__label:has-text("核心出入库类型")' })
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '业务出入库类型设置页真实渲染',
      passed:
        new URL(page.url()).pathname === route &&
        bodyText.includes('业务出入库类型') &&
        bodyText.includes('核心出入库类型') &&
        bodyText.includes('库存方向'),
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'wms-business-io-type-rule-settings', record)
    caseRecord.evidence.push('真实登录、映射规则分页、固定核心类型接口和设置页截图')
    if (!rules.length) addPartial(caseRecord, '当前没有业务出入库类型映射规则，未验证非空规则事实。')
    if (!isWmsWriteEnabled()) {
      addPartial(caseRecord, '未启用 CFOR_E2E_WRITE_FIXTURES=true，未执行历史名称快照和租户唯一性写侧验证。')
      wmsCatalogEvidence('WMS-QC-006', caseRecord, {
        0: { gap: '未启用写侧夹具，未知/停用字典值反例未执行' },
        1: ['核心出入库类型只返回固定库存方向选项'],
        2: { gap: '未创建专属字典和规则，label 快照不回溯未验证' },
        3: { gap: '未创建专属规则，租户唯一和停用规则退出写侧未验证' }
      })
      return { token, api, partial: true }
    }
    const write = await runQc006WriteSide(api, caseRecord)
    wmsCatalogEvidence('WMS-QC-006', caseRecord, {
      0: [
        '未知业务类型编码创建映射规则被后端拒绝',
        '停用字典值创建映射规则被后端拒绝'
      ],
      1: [
        '核心出入库类型只返回固定库存方向选项',
        '企业自定义核心出入库类型被固定枚举校验拒绝',
        '启用映射规则将核心类型收敛为299并拒绝106方向不一致'
      ],
      2: [
        '映射规则保存字典 label 快照并返回固定核心方向',
        '字典改名后历史映射规则名称快照不回溯'
      ],
      3: [
        '同一业务类型编码重复创建映射规则被后端拒绝',
        '停用映射规则不参与校验且保留表单核心类型'
      ]
    })
    return { token, api, partial: !write.covered || !caseRecord.passCandidate }
  }

  if (caseId === 'WMS-QC-007') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const [vehiclePage, partnerPage, deliveryPage] = await Promise.all([
      api.getBusiness('/wms/transport-vehicle/page?pageNo=1&pageSize=100'),
      api.getBusiness('/base/partner/page?pageNo=1&pageSize=100&carrierEnabled=true'),
      api.getBusiness('/erp/sale-delivery/page?pageNo=1&pageSize=100')
    ])
    const vehiclesParsed = strictList(vehiclePage)
    const partnersParsed = strictList(partnerPage)
    const deliveriesParsed = strictList(deliveryPage)
    const vehicles = vehiclesParsed.rows
    const partners = partnersParsed.rows
    const deliveries = deliveriesParsed.rows
    const employees = recordList(caseRecord, 'HRM 员工精简分页响应结构可解析',
      strictList(await api.getBusiness('/hrm/employee/simple-page?pageNo=1&pageSize=100')), '司机选择前置（非敏感完整档案）')
    if (!employees.length) addPartial(caseRecord, '当前没有可选 HRM 员工，司机引用前置不足。')
    recordList(caseRecord, '车辆分页响应结构可解析', vehiclesParsed, '车辆只读查询')
    recordList(caseRecord, '承运商分页响应结构可解析', partnersParsed, '承运商只读查询')
    recordList(caseRecord, '发货单分页响应结构可解析', deliveriesParsed, '发货单只读查询')
    if (vehicles.length) caseRecord.checks.push({
      name: '运输车辆分页返回司机和承运商回填字段',
      passed:
        vehiclesParsed.valid &&
        vehicles.every(
          (row) =>
            Object.prototype.hasOwnProperty.call(row, 'mainDriverName') &&
            Object.prototype.hasOwnProperty.call(row, 'carrierPartnerName')
        ),
      details: `vehicles=${vehicles.length}`
    })
    if (partners.length) caseRecord.checks.push({
      name: '承运商选择复用统一客商承运商角色',
      passed:
        partnersParsed.valid &&
        partners.every((row) => row?.carrierEnabled === true),
      details: `partners=${partners.length}`
    })
    if (!partners.some((row) => row.status === 'ACTIVE')) addPartial(caseRecord, '没有 ACTIVE 且启用承运商角色的客商前置。')
    const vehicle = vehicles.find((row) => row.id)
    if (vehicle) {
      const detail = (await api.getBusiness(`/wms/transport-vehicle/get?id=${encodeURIComponent(vehicle.id)}`)).data
      caseRecord.checks.push({
        name: '车辆详情与分页身份一致且保留回填字段',
        passed: String(detail?.id) === String(vehicle.id) &&
          ['mainDriverName', 'carrierPartnerName'].every((key) => Object.hasOwn(detail || {}, key)),
        details: `vehicle=${vehicle.id}; 未改动车辆状态`
      })
    }
    if (deliveries.length) caseRecord.checks.push({
      name: 'ERP 销售发货单返回运输车辆快照字段',
      passed:
        deliveriesParsed.valid &&
        deliveries.every(
          (row) =>
            Object.prototype.hasOwnProperty.call(row, 'vehicleId') &&
            Object.prototype.hasOwnProperty.call(row, 'vehicleNo') &&
            Object.prototype.hasOwnProperty.call(row, 'driverName')
        ),
      details: `deliveries=${deliveries.length}`
    })

    const permissions = await api.getBusiness('/system/auth/get-permission-info')
    const route = menuRoute(permissions?.data?.menus, [
      'wms/settings/transportVehicle/index',
      'wms/settings/transportVehicle'
    ])
    if (!route) {
      addPartial(caseRecord, '权限菜单未找到运输车辆页面，未使用旧路径代替。')
      wmsCatalogEvidence('WMS-QC-007', caseRecord, {
        0: { gap: '未进入运输车辆页面，非法 HRM 司机写侧未验证' },
        1: { gap: '未进入运输车辆页面，承运商角色与状态写侧未验证' },
        2: { gap: '未进入运输车辆页面，租户车牌唯一写侧未验证' },
        3: { gap: '未创建专属车辆，分页/详情回填未验证' },
        4: { gap: '未创建专属车辆和发货单，ERP 车辆快照未验证' }
      })
      return { token, api, partial: true }
    }
    await openRoute(page, route, { readySelector: 'input[placeholder="请输入车牌号"]' })
    const settingsText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '运输车辆设置页真实渲染',
      passed:
        new URL(page.url()).pathname === route &&
        settingsText.includes('运输车辆') &&
        settingsText.includes('承运商'),
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'wms-transport-vehicle-settings', record)
    caseRecord.evidence.push(
      '真实登录读取运输车辆、统一客商承运商角色和 ERP 销售发货车辆快照字段，并截取运输车辆设置页'
    )
    addPartial(caseRecord, `只读前置数量：车辆=${vehicles.length}、承运商=${partners.length}、发货单=${deliveries.length}；空集没有业务断言。`)
    if (!isWmsWriteEnabled()) {
      addPartial(caseRecord, '未启用 CFOR_E2E_WRITE_FIXTURES=true，未创建测试车辆和正式发货单快照。')
      wmsCatalogEvidence('WMS-QC-007', caseRecord, {
        0: { gap: '未启用写侧夹具，非法 HRM 司机反例未执行' },
        1: { gap: '未启用写侧夹具，承运商角色与 ACTIVE 反例未执行' },
        2: { gap: '未启用写侧夹具，租户车牌唯一反例未执行' },
        3: vehicles.length
          ? ['运输车辆分页返回司机和承运商回填字段', '车辆详情与分页身份一致且保留回填字段']
          : { gap: '当前没有车辆样本，回填字段未验证' },
        4: { gap: '未创建专属车辆和发货单，ERP 车辆快照未验证' }
      })
      return { token, api, partial: true }
    }
    const write = await runQc007WriteSide(api, caseRecord)
    wmsCatalogEvidence('WMS-QC-007', caseRecord, qc007CatalogEvidence)
    return { token, api, partial: !write.covered || !caseRecord.passCandidate }
  }

  if (caseId === 'WMS-QC-005') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    if (!isWmsWriteEnabled()) {
      addPartial(caseRecord, '未启用 CFOR_E2E_WRITE_FIXTURES=true，未创建 106 期初夹具。')
      return { token, api, partial: true }
    }
    const fixture = await prepareWmsFixture(api, caseRecord, 1)
    try {
      const opening = await createOpeningInventory(api, caseRecord, fixture, fixture.material, fixture.unit.id, 106)
      const duplicateResponse = await api.post('/mes/stkIo/add/submit', opening.body, qc005Rejections.duplicate)
      caseRecord.checks.push({
        name: '同一库存维度重复提交 106 期初被拒绝',
        passed: matchesExpectedBusinessRejection(duplicateResponse, qc005Rejections.duplicate.expectedBusinessRejection),
        details: `code=${duplicateResponse?.code}; msg=${duplicateResponse?.msg || duplicateResponse?.message || ''}`
      })
      const after = dataOf(await api.getBusiness(`/mes/stkIo/queryById?id=${encodeURIComponent(opening.id)}`), '106 期初审核后回读')
      const effective = Number(after?.isEffective || 0) === 1
      caseRecord.checks.push({
        name: '106 期初正式审核后单据生效',
        passed: effective,
        details: `id=${opening.id}; stage=${after?.billStage}; effective=${after?.isEffective}`
      })
      if (effective) {
        const inventory = await inventorySnapshot(api, fixture, fixture.material.id)
        const row = inventory.find((item) => String(item.materialId) === String(fixture.material.id) &&
          String(item.batchNo) === String(opening.batchNo))
        caseRecord.checks.push({
          name: '106 期初审核后唯一库存事实为 mes_stk_inventory=106',
          passed: Boolean(row) && Number(row.qty) === 106,
          details: row ? `qty=${row.qty}; warehouse=${row.warehouseId}; area=${row.wareAreaId}; location=${row.wareLocationId}; batch=${row.batchNo}` : '无匹配库存行'
        })
        const editResponse = await api.put('/mes/stkIo/edit/submit', {
          ...opening.body, id: opening.id,
          stkIoEntryList: opening.body.stkIoEntryList
        }, qc005Rejections.effectiveEdit)
        caseRecord.checks.push({
          name: '已生效 106 期初直接编辑被拒绝',
          passed: matchesExpectedBusinessRejection(editResponse, qc005Rejections.effectiveEdit.expectedBusinessRejection),
          details: `code=${editResponse?.code}; msg=${editResponse?.msg || editResponse?.message || ''}`
        })
      } else {
        addPartial(caseRecord, '106 期初正式审核未生效，库存余额和生效后直接编辑拒绝无法取得完整证据。')
      }
      caseRecord.evidence.push('专属仓库/库区/库位/物料、106 正式提交与审核、重复维度拒绝、库存事实和编辑拒绝')
    } finally {
      await cleanupWmsFixtures(withCleanupRejectionContracts(api), caseRecord)
    }

    await openRoute(page, '/wireSideWarehouse/beginningInventory')
    const pageRenderStartedAt = Date.now()
    await page.getByText('库存期初', { exact: true }).first().waitFor({
      state: 'visible',
      timeout: 60000
    })
    await page.getByRole('button', { name: '导入', exact: true }).waitFor({
      state: 'visible',
      timeout: 60000
    })
    const pageRenderDurationMs = Date.now() - pageRenderStartedAt
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '库存期初页面真实渲染导入和单据操作入口',
      passed:
        page.url().includes('/wireSideWarehouse/beginningInventory') &&
        bodyText.includes('库存期初') &&
        bodyText.includes('导入'),
      details: `${page.url()}, renderMs=${pageRenderDurationMs}`
    })
    caseRecord.checks.push({
      name: '库存期初页面稳定控件渲染耗时不超过 5 秒',
      passed: pageRenderDurationMs <= 5000,
      details: `renderMs=${pageRenderDurationMs}`
    })
    await saveScreenshot(page, outputDir, 'wms-beginning-inventory-lock', record)
    caseRecord.evidence.push('库存期初页面真实渲染导入入口和截图')
    caseRecord.notes.push(
      '106 期初夹具按独立批次/单号创建，验证重复维度拒绝、生效锁定与 mes_stk_inventory 唯一事实；' +
        '已生效期初在 cleanupWmsFixtures 中保留，未执行反审核/红冲链路。'
    )
    return { token, api }
  }

  if (caseId === 'WMS-QC-008') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const tree = await api.getBusiness('/mes/wmsWareHouse/allTree')
    const rows = Array.isArray(tree?.data) ? tree.data : []
    const warehouse = rows.find((row) => row?.id) || null
    if (!warehouse) addPartial(caseRecord, '仓库树没有可查询仓库，未执行详情事实断言。')

    if (warehouse?.id) {
      const detail = await api.getBusiness(
        `/mes/wmsWareHouse/queryById?id=${encodeURIComponent(warehouse.id)}`
      )
      const data = detail?.data || {}
      caseRecord.checks.push({
        name: '仓库详情返回库区和库位启用字段',
        passed:
          Object.prototype.hasOwnProperty.call(data, 'areaEnabled') &&
          Object.prototype.hasOwnProperty.call(data, 'locationEnabled'),
        details: `warehouseId=${warehouse.id}`
      })

      caseRecord.notes.push(
        `只读检查到 warehouseId=${warehouse.id} 的 areaEnabled=${data.areaEnabled}, locationEnabled=${data.locationEnabled}；未发送非法组合写请求。`
      )
    }

    const permissions = await api.getBusiness('/system/auth/get-permission-info')
    const route = menuRoute(permissions?.data?.menus, [
      'base/warehouseConfig/archives/index',
      'base/warehouseConfig/archives'
    ])
    if (!route) {
      addPartial(caseRecord, '权限菜单未找到仓库档案页面，未使用旧路径代替。')
      wmsCatalogEvidence('WMS-QC-008', caseRecord, {
        0: caseRecord.checks.some((check) => check.name === '仓库详情返回库区和库位启用字段')
          ? ['仓库详情返回库区和库位启用字段']
          : { gap: '未进入仓库档案页面且无仓库详情样本' },
        1: { gap: '未进入仓库档案页面，前端联动和后端非法组合未验证' },
        2: { gap: '未进入仓库档案页面，关闭库区联动未验证' },
        3: { gap: '未进入仓库档案页面，新增默认值未验证' }
      })
      return { token, api, partial: true }
    }
    await openRoute(page, route, { readySelector: 'input[placeholder="请输入仓库名称"]' })
    const create = page.getByRole('button', { name: '新增', exact: true })
    if (await create.count()) {
      // Opening an unsaved form only resets local state; never click its submit action.
      await create.click()
      const dialog = page.getByRole('dialog').last()
      const area = dialog.locator('.el-form-item').filter({ hasText: '启用库区' }).locator('.el-switch')
      const location = dialog.locator('.el-form-item').filter({ hasText: '启用库位' }).locator('.el-switch')
      try {
        await area.waitFor({ state: 'visible' })
        const isChecked = (element) => element.locator('input[role="switch"]').getAttribute('aria-checked')
        caseRecord.checks.push({
          name: '新增表单默认关闭库区库位，未保存',
          passed: await isChecked(area) === 'false' && await isChecked(location) === 'false',
          details: '仅浏览器未保存表单状态'
        })
        caseRecord.checks.push({
          name: '库区未启用时前端库位开关被禁用',
          passed: await location.locator('input[role="switch"]').isDisabled(),
          details: '真实新增表单禁止未启用库区时切换库位'
        })
        await area.click()
        await location.click()
        caseRecord.checks.push({
          name: '未保存表单启用库区后可启用库位',
          passed: await isChecked(area) === 'true' && await isChecked(location) === 'true',
          details: '仅本地表单状态'
        })
        await area.click()
        caseRecord.checks.push({
          name: '未保存表单关闭库区联动关闭库位',
          passed: await isChecked(location) === 'false',
          details: '未请求 add/edit'
        })
        await saveScreenshot(page, outputDir, 'wms-warehouse-area-location-form', record)
      } finally {
        await dialog.getByRole('button', { name: /取\s*消/ }).click()
      }
    } else addPartial(caseRecord, '账号没有仓库新增入口，默认开关及联动未验证。')
    await saveScreenshot(page, outputDir, 'wms-warehouse-area-location-switches', record)
    caseRecord.evidence.push('真实登录、仓库详情字段、未保存新增表单开关联动和专属仓库写侧持久化截图')
    try {
      const write = await runQc008WriteSide(api, caseRecord)
      if (write.pageWarehouse) {
        await verifyWarehouseBrowserPersistence({
          page, api, warehouse: write.pageWarehouse, caseRecord,
          route, openRoute, saveScreenshot, outputDir, record
        })
      }
      if (write.covered) {
        const inventoryFixture = await verifyWarehouseDimensionInventory(api, caseRecord)
        await captureWarehousePageEvidence({
          page, route, warehouse: inventoryFixture.warehouse, openRoute, saveScreenshot,
          outputDir, record, caseRecord, screenshotName: 'wms-qc-008-after-write'
        })
      }
      wmsCatalogEvidence('WMS-QC-008', caseRecord, {
        0: write.covered
          ? [
              '仓库详情返回库区和库位启用字段',
              '新增仓库默认关闭库区与库位'
            ]
          : { gap: '专属仓库未创建成功，主档显式开关持久化未验证' },
        1: write.covered
          ? [
              '关闭库区同时启用库位被后端拒绝',
              '库区未启用时前端库位开关被禁用',
              '未保存表单启用库区后可启用库位'
            ]
          : { gap: '专属仓库未创建成功，前端联动与后端校验未验证' },
        2: write.covered
          ? [
              '库位仍启用时单独关闭库区被后端拒绝',
              '未保存表单关闭库区联动关闭库位',
              '库区与库位可一并关闭并持久化'
            ]
          : { gap: '专属仓库未创建成功，关闭库区联动未验证' },
        3: caseRecord.checks.some((check) => check.name === '新增表单默认关闭库区库位，未保存') &&
          write.covered
          ? [
              '新增表单默认关闭库区库位，未保存',
              '新增仓库默认关闭库区与库位'
            ]
          : { gap: '缺少未保存表单默认值或专属仓库持久化证据' },
        audit: {
          0: [
            '关闭库区同时启用库位被后端拒绝',
            '非法库区库位组合拒绝后仓库完整原值不变'
          ],
          1: ['仓库页面关闭库区联动关闭库位并经保存刷新回读'],
          2: [
            '正式库存仓库关闭库位领域拒绝且配置库存原值不变',
            '正式库存仓库关闭库区及库位领域拒绝且配置库存原值不变'
          ]
        }
      })
      return { token, api, partial: !write.covered || !caseRecord.passCandidate }
    } finally {
      await cleanupWmsFixtures(withCleanupRejectionContracts(api), caseRecord)
    }
  }

  if (caseId === 'WMS-QC-009') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    initializeQc009CatalogChecks(caseRecord)
    const [rulePage, coreTypes, dictPage] = await Promise.all([
      api.getBusiness('/wms/business-io-type-rule/page?pageNo=1&pageSize=100'),
      api.getBusiness('/wms/business-io-type-rule/core-types'),
      api.getBusiness('/system/dict-data/page?pageNo=1&pageSize=100&dictType=wms_business_io_type')
    ])
    const rules = Array.isArray(rulePage?.data?.list) ? rulePage.data.list : []
    const coreOptions = Array.isArray(coreTypes?.data) ? coreTypes.data : []
    const dictRows = Array.isArray(dictPage?.data?.list) ? dictPage.data.list : []
    const coreCodes = new Set(coreOptions.map((item) => item?.code).filter(Boolean))
    caseRecord.checks.push({
      name: '企业业务出入库类型字典与映射规则可读',
      passed:
        dictRows.length > 0 &&
        rules.every((row) => row?.businessTypeCode && coreCodes.has(row?.coreStockIoType)),
      details: `dict=${dictRows.length} rules=${rules.length}`
    })
    caseRecord.checks.push({
      name: '核心库存类型仅暴露固定方向选项',
      passed: coreOptions.length > 0 && coreOptions.every((item) => ['IN', 'OUT'].includes(item?.direction)),
      details: `coreTypes=${coreOptions.length}`
    })
    // 企业可自定义出入库类型：字典类型无需先配置映射规则，未配置规则的类型只作为显示快照直接使用
    const ruleCodes = new Set(rules.map((row) => row?.businessTypeCode).filter(Boolean))
    const unMappedDictRows = dictRows.filter((row) => row?.value && !ruleCodes.has(row.value))
    caseRecord.checks.push({
      name: '存在无需映射规则即可直接使用的企业业务类型',
      passed: unMappedDictRows.length > 0,
      details: `dict=${dictRows.length} mapped=${ruleCodes.size} unmapped=${unMappedDictRows.length}`
    })

    // Keep the read-side contract probe; the write-side fixture below adds the
    // stronger bill-number no-orphan evidence for the same rejection.
    const unknownCode = `E2E_UNKNOWN_${Date.now()}`
    const rejected = await api.post('/mes/stkIo/add/save', {
      stockIoType: '299',
      businessTypeCode: unknownCode,
      stkIoEntryList: [],
      stkIoBomList: []
    }, qc009Rejection)
    caseRecord.checks.push({
      name: '写侧拒绝不在字典中的企业业务类型',
      passed: matchesExpectedBusinessRejection(rejected, qc009Rejection.expectedBusinessRejection) &&
        String(rejected?.msg || rejected?.message || '').includes('业务出入库类型'),
      details: `code=${rejected?.code}, msg=${rejected?.msg || rejected?.message || ''}`
    })

    try {
      const write = await runQc009WriteSide(api, caseRecord)
      return { token, api, partial: !write.covered }
    } finally {
      await cleanupWmsFixtures(withCleanupRejectionContracts(api), caseRecord)
    }
  }

  if (caseId === 'WMS-QC-010') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    // 读侧：旧 ERP 仓库表已改为 mes_wms_ware_house 的只读兼容视图，分页查询必须仍返回公共仓库数据
    const pageResp = await api.get('/erp/warehouse/page?pageNo=1&pageSize=100')
    const rows = Array.isArray(pageResp?.data?.list) ? pageResp.data.list : []
    caseRecord.checks.push({
      name: '旧 ERP 仓库兼容视图读侧仍可查询',
      passed: pageResp?.code === 0 && Array.isArray(pageResp?.data?.list),
      details: `code=${pageResp?.code} rows=${rows.length}`
    })
    caseRecord.checks.push({
      name: '兼容视图返回公共仓库主档数据',
      passed: rows.length > 0 && rows.every((row) => row?.id != null && typeof row?.name === 'string'),
      details: `rows=${rows.length}`
    })

    // 写侧：四个写接口必须返回明确的退役错误码 1030400002，而不是底层视图不可更新的 500
    const retiredCode = 1030400002
    const probeId = `E2E-QC010-NO-ROW-${Date.now()}`
    const writes = [
      ['create', (options) => api.post('/erp/warehouse/create', {
        name: 'E2E-退役校验', sort: '1', status: 0
      }, options)],
      ['update', (options) => api.put('/erp/warehouse/update', { id: probeId, name: 'E2E-退役校验', sort: '1', status: 0 }, options)],
      ['delete', (options) => api.delete(`/erp/warehouse/delete?id=${probeId}`, options)],
      [
        'update-default-status',
        (options) => api.put(`/erp/warehouse/update-default-status?id=${probeId}&defaultStatus=false`, options)
      ]
    ]
    for (const [label, invoke] of writes) {
      const resp = await rawCall(invoke, expectedRejection)
      caseRecord.checks.push({
        name: `写侧 ${label} 返回退役错误码`,
        passed: isBusinessRejection(resp) && resp.code === retiredCode,
        details: `code=${resp?.code}, msg=${resp?.msg || resp?.message || ''}`
      })
    }
    caseRecord.evidence.push(
      '真实登录验证旧 ERP 仓库兼容视图读写行为：分页读侧正常返回公共仓库数据，' +
        '新增/更新/删除/默认状态四个写接口统一返回 1030400002 退役错误码；本案例不落真实仓库数据'
    )
    const closure = dependencies.verifyLegacyWarehouse || verifyLegacyWarehouse
    await closure({ api, caseRecord, pageResponse: pageResp, dependencies })
    const route = dependencies.warehouseRoute || menuRoute(
      dataOf(await api.getBusiness('/system/auth/get-permission-info')).menus,
      ['base/warehouseConfig/archives/index', 'base/warehouseConfig/archives']
    )
    if (route) {
      await openRoute(page, route, {
        readySelector: 'input[placeholder="请输入仓库名称"]'
      })
      caseRecord.checks.push({
        name: '公共仓库档案真实页面可见',
        passed: await page.locator('input[placeholder="请输入仓库名称"]').isVisible(),
        details: page.url()
      })
      await saveScreenshot(page, outputDir, 'wms-qc-010-warehouse', record)
    } else {
      addPartial(caseRecord, '真实权限菜单没有公共仓库页面，不以旧路径代替页面证据。')
    }
    const identity = '视图与公共仓库主键和租户逐项同源'
    const projection = '启停状态及费用排序默认标记投影逐项核对'
    const readonly = [
      '数据库确认公共仓库为表且旧 ERP 仓库为不可更新视图',
      '数据库拒绝旧仓库视图 INSERT',
      '数据库拒绝旧仓库视图 UPDATE',
      '数据库拒绝旧仓库视图 DELETE'
    ]
    const mirror = [
      '定向镜像预览与 apply 仅返回只读对账结果',
      '拒绝探针和镜像对账前后仓库及历史单据明细完全不变'
    ]
    const history = [
      '销售出库历史非空明细的仓库 ID 与数量同源对账',
      '采购入库历史非空明细的仓库 ID 与数量同源对账',
      mirror[1]
    ]
    wmsCatalogEvidence(caseId, caseRecord, {
      0: readonly,
      1: [identity, ...history],
      2: [projection],
      3: mirror,
      4: ['旧 ERP 仓库兼容视图读侧仍可查询', '旧仓库非空分页逐项对应本租户公共仓库',
        '公共仓库档案真实页面可见'],
      5: writes.map(([label]) => `写侧 ${label} 返回退役错误码`),
      audit: { 0: [...readonly, identity, projection], 1: mirror, 2: history }
    })
    return {
      token, api, partial: !caseRecord.passCandidate,
      acceptanceComplete: caseRecord.passCandidate
    }
  }
  return { designed: true }
}
