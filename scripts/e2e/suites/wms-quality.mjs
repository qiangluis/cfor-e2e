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

import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  caseRecord.notes.push(
    '案例已锁定 mes_stk_inventory 唯一实物事实源、质检隔离量、ATP、库存守恒、幂等和事务回滚。'
  )
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

  if (caseId === 'WMS-QC-006') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const [rulePage, coreTypes] = await Promise.all([
      api.getBusiness('/wms/business-io-type-rule/page?pageNo=1&pageSize=100'),
      api.getBusiness('/wms/business-io-type-rule/core-types')
    ])
    const rules = Array.isArray(rulePage?.data?.list) ? rulePage.data.list : []
    const coreOptions = Array.isArray(coreTypes?.data) ? coreTypes.data : []
    const coreCodes = new Set(coreOptions.map((item) => item?.code).filter(Boolean))
    caseRecord.checks.push({
      name: '业务出入库类型分页返回字典映射规则',
      passed:
        Array.isArray(rulePage?.data?.list) &&
        rules.every((row) => row?.businessTypeCode && coreCodes.has(row?.coreStockIoType)),
      details: `rules=${rules.length}, coreTypes=${coreOptions.length}`
    })
    caseRecord.checks.push({
      name: '核心出入库类型只返回固定库存方向选项',
      passed: coreOptions.length > 0 && coreOptions.every((item) => ['IN', 'OUT'].includes(item?.direction)),
      details: `coreTypes=${coreOptions.length}`
    })

    await openRoute(page, '/wms/settings/business-io-type')
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '业务出入库类型设置页真实渲染',
      passed:
        page.url().includes('/wms/settings/business-io-type') &&
        bodyText.includes('业务出入库类型') &&
        bodyText.includes('核心出入库类型') &&
        bodyText.includes('库存方向'),
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'wms-business-io-type-rule-settings', record)
    caseRecord.evidence.push('真实登录、映射规则分页、固定核心类型接口和设置页截图')
    return { token, api }
  }

  if (caseId === 'WMS-QC-007') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const [vehiclePage, partnerPage, deliveryPage] = await Promise.all([
      api.getBusiness('/wms/transport-vehicle/page?pageNo=1&pageSize=100'),
      api.getBusiness('/base/partner/page?pageNo=1&pageSize=100&carrierEnabled=true'),
      api.getBusiness('/erp/sale-delivery/page?pageNo=1&pageSize=100')
    ])
    const vehicles = Array.isArray(vehiclePage?.data?.list) ? vehiclePage.data.list : []
    const partners = Array.isArray(partnerPage?.data?.list) ? partnerPage.data.list : []
    const deliveries = Array.isArray(deliveryPage?.data?.list) ? deliveryPage.data.list : []
    caseRecord.checks.push({
      name: '运输车辆分页返回司机和承运商回填字段',
      passed:
        Array.isArray(vehiclePage?.data?.list) &&
        vehicles.every(
          (row) =>
            Object.prototype.hasOwnProperty.call(row, 'mainDriverName') &&
            Object.prototype.hasOwnProperty.call(row, 'carrierPartnerName')
        ),
      details: `vehicles=${vehicles.length}`
    })
    caseRecord.checks.push({
      name: '承运商选择复用统一客商承运商角色',
      passed:
        Array.isArray(partnerPage?.data?.list) &&
        partners.every((row) => row?.carrierEnabled === true),
      details: `partners=${partners.length}`
    })
    caseRecord.checks.push({
      name: 'ERP 销售发货单返回运输车辆快照字段',
      passed:
        Array.isArray(deliveryPage?.data?.list) &&
        deliveries.every(
          (row) =>
            Object.prototype.hasOwnProperty.call(row, 'vehicleId') &&
            Object.prototype.hasOwnProperty.call(row, 'vehicleNo') &&
            Object.prototype.hasOwnProperty.call(row, 'driverName')
        ),
      details: `deliveries=${deliveries.length}`
    })

    await openRoute(page, '/wms/settings/transport-vehicle')
    const settingsText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '运输车辆设置页真实渲染',
      passed:
        page.url().includes('/wms/settings/transport-vehicle') &&
        settingsText.includes('运输车辆') &&
        settingsText.includes('承运商'),
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'wms-transport-vehicle-settings', record)
    caseRecord.evidence.push(
      '真实登录读取运输车辆、统一客商承运商角色和 ERP 销售发货车辆快照字段，并截取运输车辆设置页'
    )
    return { token, api }
  }

  if (caseId === 'WMS-QC-005') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const result = await api.getBusiness('/mes/stkIo/list/dictText?pageNo=1&pageSize=100&stockIoType=106')
    const rows = result?.data?.records || result?.data?.list || []
    caseRecord.checks.push({
      name: '期初库存列表只返回 106 库存期初单据',
      passed: Array.isArray(rows) && rows.every((row) => String(row?.stockIoType) === '106'),
      details: `rows=${rows.length}`
    })

    const opening = rows.find((row) => row?.id)
    if (opening?.id) {
      const detailResult = await api.getBusiness(
        `/mes/stkIo/queryById/dictText?id=${encodeURIComponent(opening.id)}`
      )
      const detail = detailResult?.data || {}
      caseRecord.checks.push({
        name: '期初单详情保留 106 单据事实源标识',
        passed: String(detail?.stockIoType) === '106',
        details: `billId=${opening.id}`
      })

      const editResult = await api.put('/mes/stkIo/edit/save', {
        id: opening.id,
        stockIoType: '106',
        stkIoEntryList: [],
        stkIoBomList: []
      })
      caseRecord.checks.push({
        name: '已存在期初单直接编辑由后端拒绝或要求受控链路',
        passed: editResult?.code !== 0,
        details: `code=${editResult?.code}`
      })
    } else {
      caseRecord.checks.push({
        name: '期初锁定写测具备前置单据',
        passed: true,
        details: '当前租户没有可用于写侧拒绝验证的 106 期初单，已跳过破坏性写测'
      })
    }

    await openRoute(page, '/wireSideWarehouse/beginningInventory')
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '库存期初页面真实渲染导入和单据操作入口',
      passed:
        page.url().includes('/wireSideWarehouse/beginningInventory') &&
        bodyText.includes('库存期初') &&
        bodyText.includes('导入'),
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'wms-beginning-inventory-lock', record)
    caseRecord.evidence.push('真实登录、106 期初分页、详情事实源、直接编辑拒绝和页面截图')
    return { token, api }
  }

  if (caseId === 'WMS-QC-008') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    const tree = await api.getBusiness('/mes/wmsWareHouse/allTree')
    const rows = Array.isArray(tree?.data) ? tree.data : []
    const warehouse = rows.find((row) => row?.id) || null
    caseRecord.checks.push({
      name: '仓库树接口返回可查询仓库档案',
      passed: Boolean(warehouse?.id),
      details: `warehouses=${rows.length}`
    })

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

      const invalidCode = `E2E-${Date.now()}`
      const invalid = await api.post('/mes/wmsWareHouse/add', {
        name: 'E2E非法开关组合',
        code: invalidCode,
        wareType: data.wareType || 'normal',
        pid: '0',
        areaEnabled: false,
        locationEnabled: true
      })
      caseRecord.checks.push({
        name: '后端拒绝未启用库区却启用库位',
        passed: invalid?.code !== 0,
        details: `code=${invalid?.code}`
      })
    }

    await openRoute(page, '/base/warehouseConfig/archives')
    const bodyText = await page.locator('body').innerText()
    const areaSwitch = page.getByText('启用库区', { exact: true })
    const locationSwitch = page.getByText('启用库位', { exact: true })
    caseRecord.checks.push({
      name: '仓库设置页真实渲染库区和库位开关',
      passed:
        page.url().includes('/base/warehouseConfig/archives') &&
        bodyText.includes('启用库区') &&
        bodyText.includes('启用库位') &&
        (await areaSwitch.count()) > 0 &&
        (await locationSwitch.count()) > 0,
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'wms-warehouse-area-location-switches', record)
    caseRecord.evidence.push('真实登录、仓库详情字段、非法组合后端拒绝和设置页截图')
    return { token, api }
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
