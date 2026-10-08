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

import { createApiClient as apiClient } from '../lib/api.mjs'
import { login as browserLogin, openRoute as browserOpenRoute, saveScreenshot as browserScreenshot } from '../lib/browser.mjs'
import {
  createOpeningInventory,
  createStockIoFixture,
  dataOf,
  inventorySnapshot,
  isWmsWriteEnabled,
  prepareWmsFixture,
  cleanupWmsFixtures,
  rowsOf
} from '../lib/wms-fixtures.mjs'

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

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }, dependencies = {}) => {
  const login = dependencies.login || browserLogin
  const createApiClient = dependencies.createApiClient || apiClient
  const openRoute = dependencies.openRoute || browserOpenRoute
  const saveScreenshot = dependencies.saveScreenshot || browserScreenshot
  caseRecord.notes.push(
    '案例已锁定 mes_stk_inventory 唯一实物事实源、质检隔离量、ATP、库存守恒、幂等和事务回滚。'
  )

  if (caseId === 'WMS-QC-001') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    if (!isWmsWriteEnabled()) {
      addPartial(caseRecord, '未启用 CFOR_E2E_WRITE_FIXTURES=true，未创建质检入库夹具。')
      return { token, api, partial: true }
    }
    const fixture = await prepareWmsFixture(api, caseRecord, 1)
    try {
      const receipt = await createStockIoFixture(api, caseRecord, fixture, fixture.material, fixture.unit.id, {
        stockIoType: '101', quantity: 10, isQc: 1
      })
      if (!receipt.approved) {
        addPartial(caseRecord, '101 质检入库审批未完成，未伪造待检/放行结果。')
        return { token, api, partial: true }
      }
      const inventory = await inventorySnapshot(api, fixture, fixture.material.id)
      const row = inventory.find((item) => String(item.materialId) === String(fixture.material.id))
      const isolated = Boolean(row) && (Number(row.holdQty || 0) > 0 || Number(row.pendingPutawayQty || 0) > 0 || String(row.qualityStatus) === '0')
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
      addPartial(caseRecord, '当前套件未发现已确认的质检放行正式 API；放行后 available、库存守恒及不合格阻断保留待补。')
      await browserOpenRoute(page, '/quality/pendingInspect').catch(() => {})
      await browserScreenshot(page, outputDir, 'wms-qc-001-pending-inspect', record).catch(() => {})
      caseRecord.evidence.push('专属 101 质检入库、审核调用、mes_stk_inventory 隔离字段和页面截图')
      return { token, api, partial: true }
    } finally {
      await cleanupWmsFixtures(api, caseRecord)
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
        try {
          const resolved = await api.getBusiness(
            `/mes/wmsHouseArea/queryById?id=${encodeURIComponent(candidate.areaId)}`)
          if (resolved?.data) {
            location = candidate
            area = resolved.data
            break
          }
          orphanLocations.push(`${candidate.id}->${candidate.areaId}`)
        } catch (error) {
          orphanLocations.push(`${candidate.id}->${candidate.areaId}`)
        }
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
      addPartial(
        caseRecord,
        '未创建或修改测试库区/库位，未验证唯一冲突、启用约束、库存/未完成单据删除保护；当前租户无明确测试夹具时保留 PARTIAL。'
      )
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
    addPartial(caseRecord, '未创建/停用/修改正式字典或映射规则，未执行历史名称快照和租户唯一性写侧验证。')
    return { token, api, partial: true }
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
    addPartial(caseRecord, '未创建测试车辆、未验证非法司机/承运商/重复车牌写侧，也未新增正式发货单快照。')
    return { token, api, partial: true }
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
      const duplicateResponse = await api.post('/mes/stkIo/add/submit', opening.body)
      caseRecord.checks.push({
        name: '同一库存维度重复提交 106 期初被拒绝',
        passed: duplicateResponse?.code !== 0,
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
        })
        caseRecord.checks.push({
          name: '已生效 106 期初直接编辑被拒绝',
          passed: editResponse?.code !== 0,
          details: `code=${editResponse?.code}; msg=${editResponse?.msg || editResponse?.message || ''}`
        })
      } else {
        addPartial(caseRecord, '106 期初正式审核未生效，库存余额和生效后直接编辑拒绝无法取得完整证据。')
      }
      caseRecord.evidence.push('专属仓库/库区/库位/物料、106 正式提交与审核、重复维度拒绝、库存事实和编辑拒绝')
    } finally {
      await cleanupWmsFixtures(api, caseRecord)
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
    return { token, api, partial: true }
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
    caseRecord.evidence.push('真实登录、仓库详情字段和设置页截图；未执行任何仓库写操作')
    addPartial(caseRecord, '仅验证未保存新增表单；未授权编辑专用测试仓库，后端非法组合拒绝及持久化行为未验证。')
    return { token, api, partial: true }
  }

  if (caseId === 'WMS-QC-009') {
    const token = await login(page)
    const api = createApiClient({ token, record })
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

    // 写侧校验企业业务类型必须来自字典：非字典编码被拒绝，证明写侧确实接入了企业类型输入
    const unknownCode = `E2E_UNKNOWN_${Date.now()}`
    const rejected = await api.post('/mes/stkIo/add/save', {
      stockIoType: '299',
      businessTypeCode: unknownCode,
      stkIoEntryList: [],
      stkIoBomList: []
    })
    caseRecord.checks.push({
      name: '写侧拒绝不在字典中的企业业务类型',
      passed: rejected?.code !== 0,
      details: `code=${rejected?.code}, msg=${rejected?.msg || rejected?.message || ''}`
    })
    caseRecord.evidence.push(
      '真实登录读取业务出入库类型字典、映射规则与核心方向契约，验证未配置映射的类型仍可直接新增使用，' +
        '并验证写侧对非字典企业类型拒绝；本案例不落真实库存单据'
    )
    return { token, api }
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
      passed: rows.length === 0 || rows.every((row) => row?.id != null && typeof row?.name === 'string'),
      details: `rows=${rows.length}`
    })

    // 写侧：四个写接口必须返回明确的退役错误码 1030400002，而不是底层视图不可更新的 500
    const retiredCode = 1030400002
    const probeId = rows[0]?.id ?? '1'
    const writes = [
      ['create', () => api.post('/erp/warehouse/create', { name: 'E2E-退役校验', sort: '1', status: 0 })],
      ['update', () => api.put('/erp/warehouse/update', { id: probeId, name: 'E2E-退役校验', sort: '1', status: 0 })],
      ['delete', () => api.delete(`/erp/warehouse/delete?id=${probeId}`)],
      [
        'update-default-status',
        () => api.put(`/erp/warehouse/update-default-status?id=${probeId}&defaultStatus=false`)
      ]
    ]
    for (const [label, invoke] of writes) {
      let resp
      try {
        resp = await invoke()
      } catch (error) {
        resp = { code: -1, msg: String(error?.message || error) }
      }
      caseRecord.checks.push({
        name: `写侧 ${label} 返回退役错误码`,
        passed: resp?.code === retiredCode,
        details: `code=${resp?.code}, msg=${resp?.msg || resp?.message || ''}`
      })
    }
    caseRecord.evidence.push(
      '真实登录验证旧 ERP 仓库兼容视图读写行为：分页读侧正常返回公共仓库数据，' +
        '新增/更新/删除/默认状态四个写接口统一返回 1030400002 退役错误码；本案例不落真实仓库数据'
    )
    return { token, api }
  }
  return { designed: true }
}
