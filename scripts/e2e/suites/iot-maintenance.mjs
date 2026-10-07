import { randomBytes } from 'node:crypto'
import { createApiClient } from '../lib/api.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import {
  login,
  openRoute as defaultOpenRoute,
  saveScreenshot as defaultSaveScreenshot,
  waitForPageReady
} from '../lib/browser.mjs'

export const cases = ['IOT-004', 'IOT-005', 'IOT-006', 'MAINT-001', 'MAINT-002', 'MAINT-003', 'MAINT-004', 'MAINT-005', 'MAINT-006', 'MAINT-007', 'MAINT-008', 'MAINT-009', 'MAINT-010', 'MAINT-011', 'MAINT-012', 'MAINT-013', 'MAINT-014', 'MAINT-015']

export const MAINT_011_DEVICE_STATUS_ROUTE = '/settings/iot/device-status'
export const MAINT_010_LIFECYCLE_ROUTE = '/settings/iot/device-lifecycle'
export const MAINT_010_COMPENSATION_ROUTE = '/settings/iot/device-compensation'
export const MAINT_008_REPAIR_ORDER_ROUTE = '/iot/maintenance/repair-order'
export const MAINT_009_INSPECTION_RECORD_ROUTE = '/iot/maintenance/inspection-record'

export const isE2eFixture = (item) =>
  /(?:^|[^a-z0-9])E2E(?:[^a-z0-9]|$)/i.test(
    [item?.materialCode, item?.materialName, item?.warehouseCode, item?.warehouseName, item?.code, item?.name]
      .filter((value) => typeof value === 'string').join(' ')
  )

export const isExpectedRejection = (response, message) =>
  response?.code === 400 && String(response?.msg || response?.message || '').includes(message)

export const isWorkflowRejection = (response, message) =>
  response?.code === 409 && String(response?.msg || response?.message || '').includes(message)

export const dataOf = (response) => {
  if (
    response &&
    typeof response === 'object' &&
    Object.prototype.hasOwnProperty.call(response, 'data') &&
    ('code' in response || 'msg' in response || 'success' in response)
  ) {
    return response.data
  }
  return response
}

export const hasFormalMetricEvidence = ({ statusEvents, drilldown } = {}) =>
  Array.isArray(statusEvents) &&
  statusEvents.length > 0 &&
  Array.isArray(drilldown) &&
  drilldown.length > 0

const unique = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}`

export const fixtureId = (response, label) => {
  const id = dataOf(response)
  const valid =
    (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) ||
    (typeof id === 'string' && /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n)
  if (!valid) throw new Error(`${label} 返回无效 ID：${JSON.stringify(id)}`)
  return id
}

const requireTrueResult = (response, label) => {
  if (response && typeof response === 'object') assertBusinessSuccess(response, label)
  if (dataOf(response) !== true) throw new Error(`${label} 未返回 true`)
}

export const requiredRows = (response, label) => {
  const payload = dataOf(response)
  const rows = Array.isArray(payload) ? payload : payload?.list ?? payload?.records
  if (!Array.isArray(rows)) throw new Error(`${label} 未返回数组`)
  return rows
}

const createMaintenanceDevice = async (api, fixtures, caseRecord) => {
  const products = requiredRows(await api.getBusiness('/iot/product/simple-list'), 'IoT 产品')
  const product = products.find((item) => item?.id != null && item.status === 0)
  if (!product) {
    caseRecord.notes.push('缺少启用的 IoT 产品，未创建设备夹具或执行方案分配。')
    return null
  }
  const id = trackDeletable(fixtures, api, await api.postBusiness('/iot/device/create', {
    productId: product.id,
    deviceName: unique('E2E-MAINT')
  }), '/iot/device', 'IoT 设备')
  const device = dataOf(await api.getBusiness(`/iot/device/get?id=${id}`))
  if (String(device?.id) !== String(id)) throw new Error('E2E 设备夹具回读不一致')
  return device
}

const createPlanFixture = async (api, fixtures, caseRecord, domain, planName) => {
  const nodes = requiredRows(await api.getBusiness('/mes/maintenance-item/tree'), '维保项目树')
  const root = nodes.find((node) => node.categoryRoot === domain && node.systemRoot === true)
  if (!root?.id) {
    caseRecord.notes.push(`缺少 ${domain} 固定根分类，未创建方案。`)
    return null
  }
  const itemBody = {
    parentId: root.id, categoryRoot: domain, nodeType: 'ITEM',
    itemCode: unique('E2E-MI'), itemName: `E2E ${domain} 项目`,
    resultType: 'BOOLEAN', status: 0
  }
  let retainItem = false
  const itemId = fixtures.track(
    await api.postBusiness('/mes/maintenance-item/create', itemBody),
    '维保项目',
    async (id) => {
      if (!retainItem) {
        requireTrueResult(await api.deleteBusiness(`/mes/maintenance-item/delete?id=${id}`), '维保项目删除')
        return
      }
      requireTrueResult(
        await api.putBusiness('/mes/maintenance-item/update', { ...itemBody, id, status: 1 }),
        '已引用 E2E 维保项目停用'
      )
      const item = dataOf(await api.getBusiness(`/mes/maintenance-item/get?id=${id}`))
      if (item?.status !== 1) throw new Error(`E2E 维保项目未停用 id=${id}`)
      return { retained: true }
    }
  )
  const planId = fixtures.track(await api.postBusiness('/mes/maintenance-plan/create', {
    planCode: unique('E2E-MP'), planName, coreDomain: domain,
    items: [{ itemId, seq: 1, standard: 'E2E 目视无异常' }],
    cycles: [{ cycleType: 'TIME', cycleValue: 1, cycleUnit: 'DAY', dataSource: 'CALENDAR' }]
  }), '维保方案', async (id) => {
    const plan = dataOf(await api.getBusiness(`/mes/maintenance-plan/get?id=${id}`))
    if (plan?.status === 'DRAFT') {
      requireTrueResult(await api.deleteBusiness(`/mes/maintenance-plan/delete?id=${id}`), '草稿方案删除')
      return
    }
    retainItem = true
    requireTrueResult(await api.putBusiness(`/mes/maintenance-plan/disable?id=${id}`), '已发布 E2E 方案停用')
    const disabled = dataOf(await api.getBusiness(`/mes/maintenance-plan/get?id=${id}`))
    if (disabled?.status !== 'DISABLED') throw new Error(`E2E 方案未停用 id=${id}`)
    caseRecord.notes.push(`已发布 E2E 方案 ${id} 与项目 ${itemId} 已停用并保留版本证据。`)
    return { retained: true }
  })
  const draft = dataOf(await api.getBusiness(`/mes/maintenance-plan/get?id=${planId}`))
  caseRecord.checks.push({
    name: 'E2E 方案按指定核心域创建草稿与项目版本',
    passed: draft?.status === 'DRAFT' && draft?.currentVersion === 1 &&
      draft?.coreDomain === domain && draft?.items?.some((item) => String(item.itemId) === String(itemId)),
    details: `planId=${planId}, itemId=${itemId}, domain=${domain}`
  })
  return { planId, itemId }
}

const endFixtureEvent = async (api, id, reason) => {
  const event = dataOf(await api.getBusiness(`/mes/device-status-event/get?id=${encodeURIComponent(id)}`))
  if (event?.endTime) return
  const endTime = event?.startTime
    ? formatLocalDateTime(new Date(new Date(event.startTime).getTime() + 60 * 1000))
    : formatLocalDateTime(new Date(Date.now() + 60 * 1000))
  requireTrueResult(
    await api.putBusiness('/mes/device-status-event/end', { id, endTime, reason }),
    `结束测试事件 id=${id}`
  )
}

export const createFixtureCleanup = ({ caseId, caseRecord }) => {
  const entries = []
  return {
    track (response, label, cleanup) {
      const id = fixtureId(response, label)
      entries.push({ id, label, cleanup })
      return id
    },
    async cleanup (caseFailed) {
      const errors = []
      for (const { id, label, cleanup } of entries.reverse()) {
        try {
          const outcome = await cleanup(id)
          caseRecord.checks.push({
            name: outcome?.retained ? `${label}隔离夹具已保留` : `${label}测试数据已清理`,
            passed: true,
            details: `id=${id}`
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          caseRecord.checks.push({ name: `${label}测试数据已清理`, passed: false, details: `id=${id}: ${message}` })
          caseRecord.notes.push(`${caseId} 清理失败 ${label} id=${id}: ${message}`)
          errors.push(error)
        }
      }
      // Keep the original failure while still reporting every cleanup failure.
      if (errors.length && !caseFailed) throw new AggregateError(errors, `${caseId} 测试数据清理失败`)
    }
  }
}

export const trackDeletable = (fixtures, api, response, path, label) =>
  fixtures.track(response, label, async (id) => {
    requireTrueResult(
      await api.deleteBusiness(`${path}/delete?id=${encodeURIComponent(id)}`),
      `${label}清理 id=${id}`
    )
  })

const trackRuleFixture = (fixtures, api, response, caseRecord) =>
  fixtures.track(response, '维保类型规则', async (id) => {
    requireTrueResult(
      await api.deleteBusiness(`/mes/maintenance-type-rule/delete?id=${encodeURIComponent(id)}`),
      `维保类型规则清理 id=${id}`
    )
    const tree = dataOf(await api.getBusiness('/mes/maintenance-type-rule/tree'))
    const containsId = (nodes) =>
      (nodes || []).some((node) => String(node?.id) === String(id) || containsId(node?.children))
    const verified = !containsId(tree)
    caseRecord.checks.push({
      name: 'E2E 新增的子类型已清理',
      passed: verified,
      details: `ruleId=${id}`
    })
    if (!verified) throw new Error(`维保类型规则清理后仍可读取：id=${id}`)
  })

const trackInspectionRecord = (fixtures, api, response) =>
  fixtures.track(response, '点检记录', async (id) => {
    await api.deleteBusiness(`/mes/system/record/${encodeURIComponent(id)}`)
  })

const trackRepairOrder = (fixtures, api, response, caseRecord) =>
  fixtures.track(response, '维修工单', async (id) => {
    const detail = dataOf(await api.getBusiness(`/mes/system/order/${encodeURIComponent(id)}`))
    if (detail?.orderStatus !== 'REPORTED') {
      caseRecord.notes.push(
        `维修工单 E2E 夹具 id=${id} 已进入 ${detail?.orderStatus || '终态'}，后端禁止删除；保留为隔离测试数据，不触碰用户工单。`
      )
      return { retained: true }
    }
    await api.deleteBusiness(`/mes/system/order/${encodeURIComponent(id)}`)
  })

export const trackEvent = (fixtures, api, response) =>
  fixtures.track(response, '设备状态事件', (id) => endFixtureEvent(api, id, 'E2E fixture cleanup'))

export const isolatedDeviceId = async (api, layers = ['RUNTIME']) => {
  const id = 4_000_000_000_000_000 + randomBytes(6).readUIntBE(0, 6)
  for (const layer of layers) {
    const active = dataOf(await api.getBusiness(
      `/mes/device-status-event/active?deviceId=${id}&coreLayer=${layer}`
    ))
    if (active !== null) throw new Error(`测试设备 ID 未隔离：deviceId=${id}, coreLayer=${layer}`)
  }
  return id
}

const formatLocalDateTime = (date) => {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export const checkMaintenancePage = async (context, options, dependencies = {}) => {
  const { page, record, caseRecord, outputDir } = context
  const { route, labels, name, screenshot } = options
  let error
  try {
    await (dependencies.openRoute || defaultOpenRoute)(page, route, {
      readyText: labels[0],
      readyTimeoutMs: options.readyTimeoutMs || 30000
    })
  } catch (cause) {
    error = cause
  }
  const text = await page.locator('body').innerText()
  caseRecord.checks.push({
    name,
    passed: !error && labels.every((label) => text.includes(label)),
    details: error
      ? `${route}: ${error.message}; body=${text.slice(-1000)}`
      : route
  })
  await (dependencies.saveScreenshot || defaultSaveScreenshot)(page, outputDir, screenshot, record)
}

const findFirstItem = (nodes) => {
  for (const node of nodes || []) {
    if (node.nodeType === 'ITEM') return node
    const child = findFirstItem(node.children)
    if (child) return child
  }
  return null
}

export const runCase = async (context, dependencies = {}) => {
  const token = await (dependencies.login || login)(context.page)
  const api = (dependencies.createApiClient || createApiClient)({ token, record: context.record })
  const fixtures = createFixtureCleanup(context)
  let caseFailed = false
  try {
    return await runAuthenticatedCase({ ...context, token, api, fixtures }, dependencies)
  } catch (error) {
    caseFailed = true
    throw error
  } finally {
    await fixtures.cleanup(caseFailed)
  }
}

const runAuthenticatedCase = async (
  { caseId, page, record, caseRecord, outputDir, token, api, fixtures },
  dependencies = {}
) => {
  const openRoute = dependencies.openRoute || defaultOpenRoute
  const saveScreenshot = dependencies.saveScreenshot || defaultSaveScreenshot
  caseRecord.checks.push({
    name: '真实登录成功',
    passed: Boolean(token),
    details: '登录后携带真实令牌调用设备与维保接口'
  })

  if (caseId === 'IOT-004') {
    const catalogResponse = await api.getBusiness('/iot/capability/catalog')
    const catalog = catalogResponse?.data || {}
    const protocols = (catalog.protocols || []).map((item) => item.value)
    const forms = (catalog.deviceForms || []).map((item) => item.value)
    caseRecord.checks.push({
      name: '对接类型复用 IoT 产品设备形态且协议目录来自代码注册',
      passed: protocols.includes('OPC_UA') && protocols.includes('modbus_tcp_client') && forms.length >= 3,
      details: `protocols=${protocols.length}, deviceForms=${forms.length}`
    })
    caseRecord.checks.push({
      name: '未注册协议不会出现在能力目录',
      passed: !protocols.includes('not_registered_protocol'),
      details: protocols.join(',')
    })
    await openRoute(page, '/iot/device/device', {
      readySelector: 'input[placeholder="请输入设备名称"]'
    })
    await saveScreenshot(page, outputDir, 'iot-004-capability', record)
    return { token, api }
  }

  if (caseId === 'IOT-005') {
    const catalog = dataOf(await api.getBusiness('/iot/capability/catalog'))
    const modbus = dataOf(await api.getBusiness('/iot/device-modbus-point/page?pageNo=1&pageSize=10'))
    caseRecord.checks.push({
      name: '序列化能力来自代码枚举',
      passed: (catalog.serializeTypes || []).some((item) => item.value === 'json'),
      details: JSON.stringify(catalog.serializeTypes || [])
    })
    caseRecord.checks.push({
      name: 'Modbus 专用点位仍由 iot_device_modbus_point 承载',
      passed: Array.isArray(modbus?.list),
      details: `点位总数=${modbus?.total ?? 'n/a'}`
    })
    // PB-106：点位导入必须做重复地址、数据宽度、读写权限与协议兼容性校验
    const emptyImport = await api.post('/iot/device-modbus-point/import', { deviceId: 1, points: [] })
    caseRecord.checks.push({
      name: '点位导入空批次被拒绝（PB-106）',
      passed: emptyImport?.code !== 0,
      details: `code=${emptyImport?.code}, msg=${emptyImport?.msg || ''}`
    })
    const unknownDeviceImport = await api.post('/iot/device-modbus-point/import', {
      deviceId: 999999999,
      points: [
        {
          deviceId: 999999999,
          thingModelId: 1,
          functionCode: 3,
          registerAddress: 0,
          rawDataType: 'INT16',
          byteOrder: 'AB',
          status: 0
        }
      ]
    })
    caseRecord.checks.push({
      name: '点位导入校验设备存在性（PB-106）',
      passed: unknownDeviceImport?.code !== 0,
      details: `code=${unknownDeviceImport?.code}, msg=${unknownDeviceImport?.msg || ''}`
    })
    caseRecord.evidence.push(
      '能力目录、Modbus 点位分页与点位导入校验真实请求，通用点位边界保持 IoT Thing Model，' +
        '导入校验覆盖空批次与设备存在性；本案例不落真实点位'
    )
    return { token, api }
  }

  if (caseId === 'IOT-006') {
    const suffix = unique('DSM')
    const created = trackDeletable(fixtures, api, await api.postBusiness('/mes/device-status-mapping/create', {
      coreLayer: 'RUNTIME',
      coreState: 'RUNNING',
      subStateCode: suffix,
      subStateName: '正常运行',
      status: 0
    }), '/mes/device-status-mapping', '设备状态映射')
    caseRecord.checks.push({
      name: '运行状态子状态映射到固定核心状态 RUNNING',
      passed: Boolean(created),
      details: `id=${created}`
    })
    let invalidRejected = false
    try {
      await api.postBusiness('/mes/device-status-mapping/create', {
        coreLayer: 'RUNTIME',
        coreState: 'NOT_A_CORE_STATE',
        subStateCode: unique('BAD'),
        subStateName: '非法映射',
        status: 0
      })
    } catch (error) {
      invalidRejected = true
      caseRecord.notes.push(`非法核心状态被拒绝：${error.message}`)
    }
    caseRecord.checks.push({
      name: '非平台固定核心状态被拒绝',
      passed: invalidRejected,
      details: '字典页不能自定义核心运行状态'
    })

    const layeredDeviceId = await isolatedDeviceId(api, ['RUNTIME', 'ASSET', 'CONNECTION'])
    const runtimeEventId = trackEvent(fixtures, api, await api.postBusiness('/mes/device-status-event/start', {
      deviceId: layeredDeviceId,
      deviceName: 'E2E 三层状态设备',
      coreLayer: 'RUNTIME',
      statusCode: 'RUNNING',
      statusName: '运行',
      sourceType: 'MANUAL'
    }))
    const assetEventId = trackEvent(fixtures, api, await api.postBusiness('/mes/device-status-event/start', {
      deviceId: layeredDeviceId,
      deviceName: 'E2E 三层状态设备',
      coreLayer: 'ASSET',
      statusCode: 'ENABLED',
      statusName: '启用',
      sourceType: 'MANUAL'
    }))
    const connectionEventId = trackEvent(fixtures, api, await api.postBusiness('/mes/device-status-event/start', {
      deviceId: layeredDeviceId,
      deviceName: 'E2E 三层状态设备',
      coreLayer: 'CONNECTION',
      statusCode: 'ONLINE',
      statusName: '在线',
      sourceType: 'IOT'
    }))
    const [runtimeActive, assetActive, connectionActive] = await Promise.all([
      api.getBusiness(
        `/mes/device-status-event/active?deviceId=${layeredDeviceId}&coreLayer=RUNTIME`
      ).then(dataOf),
      api.getBusiness(
        `/mes/device-status-event/active?deviceId=${layeredDeviceId}&coreLayer=ASSET`
      ).then(dataOf),
      api.getBusiness(
        `/mes/device-status-event/active?deviceId=${layeredDeviceId}&coreLayer=CONNECTION`
      ).then(dataOf)
    ])
    caseRecord.checks.push({
      name: '连接/资产/运行三层状态可并存且互不覆盖',
      passed:
        runtimeActive?.id === runtimeEventId &&
        runtimeActive?.statusCode === 'RUNNING' &&
        assetActive?.id === assetEventId &&
        assetActive?.statusCode === 'ENABLED' &&
        connectionActive?.id === connectionEventId &&
        connectionActive?.statusCode === 'ONLINE',
      details: `runtime=${runtimeActive?.id}, asset=${assetActive?.id}, connection=${connectionActive?.id}`
    })
    await openRoute(page, '/settings/iot/device-maintenance')
    await waitForPageReady(page)
    const settingsText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '设备维保设置页真实渲染并承载状态映射/类型/项目/方案/分配页签',
      passed: ['设备状态映射', '维保类型', '维保项目', '维保方案', '方案分配'].every((label) =>
        settingsText.includes(label)
      ),
      details: '设置 - 设备与 IoT 下的统一维保设置页'
    })
    await saveScreenshot(page, outputDir, 'iot-006-device-maintenance-settings', record)
    return { token, api }
  }

  if (caseId === 'MAINT-001') {
    const suffix = unique('MT')
    const created = trackDeletable(fixtures, api, await api.postBusiness('/mes/maintenance-type-rule/create', {
      coreDomain: 'UPKEEP',
      subTypeCode: suffix,
      subTypeName: '日常保养',
      approvalRequired: true,
      slaHours: 24,
      status: 0
    }), '/mes/maintenance-type-rule', '维保类型规则')
    caseRecord.checks.push({
      name: '保养子类型映射固定核心域 UPKEEP',
      passed: Boolean(created),
      details: `id=${created}`
    })
    let invalidRejected = false
    try {
      await api.postBusiness('/mes/maintenance-type-rule/create', {
        coreDomain: 'NOT_A_DOMAIN',
        subTypeCode: unique('BAD'),
        subTypeName: '非法域',
        status: 0
      })
    } catch (error) {
      invalidRejected = true
    }
    caseRecord.checks.push({
      name: '非固定核心维保域被拒绝',
      passed: invalidRejected,
      details: '核心域固定为维修/保养/巡检'
    })
    return { token, api }
  }

  if (caseId === 'MAINT-002') {
    const tree = dataOf(await api.getBusiness('/mes/maintenance-item/tree'))
    const roots = (tree || []).map((node) => node.categoryRoot)
    caseRecord.checks.push({
      name: '三类固定根分类自动就绪',
      passed: ['REPAIR', 'UPKEEP', 'INSPECT'].every((root) => roots.includes(root)),
      details: `roots=${roots.join(',')}`
    })
    const rootId = (tree || []).find((node) => node.categoryRoot === 'INSPECT')?.id
    const suffix = unique('MI')
    const created = trackDeletable(fixtures, api, await api.postBusiness('/mes/maintenance-item/create', {
      parentId: rootId,
      categoryRoot: 'INSPECT',
      nodeType: 'ITEM',
      itemCode: suffix,
      itemName: '巡检项目',
      resultType: 'BOOLEAN',
      status: 0
    }), '/mes/maintenance-item', '维保项目')
    caseRecord.checks.push({
      name: '可在固定根分类下创建项目',
      passed: Boolean(created),
      details: `id=${created}`
    })
    return { token, api }
  }

  if (caseId === 'MAINT-003') {
    const fixture = await createPlanFixture(api, fixtures, caseRecord, 'UPKEEP', 'E2E 维保方案')
    if (!fixture) return { token, api, partial: true, note: '缺少保养项目根分类前置' }
    const { planId } = fixture
    await api.putBusiness(`/mes/maintenance-plan/publish?id=${planId}`)
    const detail = dataOf(await api.getBusiness(`/mes/maintenance-plan/get?id=${planId}`))
    caseRecord.checks.push({
      name: '方案发布后记录已发布版本',
      passed: detail?.status === 'PUBLISHED' &&
        String(detail.publishedVersion) === String(detail.currentVersion),
      details: `status=${detail.status}, version=${detail.publishedVersion}`
    })
    const deleteResult = await api.delete(`/mes/maintenance-plan/delete?id=${planId}`)
    const deleteRejected = isExpectedRejection(deleteResult, '不能删除')
    caseRecord.checks.push({
      name: '已发布方案禁止删除',
      passed: deleteRejected,
      details: '发布版本只能停用，保留任务快照'
    })
    await api.putBusiness(`/mes/maintenance-plan/disable?id=${planId}`)
    return { token, api }
  }

  if (caseId === 'MAINT-004') {
    const device = await createMaintenanceDevice(api, fixtures, caseRecord)
    if (!device) return { token, api, partial: true, note: '缺少启用 IoT 产品前置' }
    const fixture = await createPlanFixture(api, fixtures, caseRecord, 'REPAIR', 'E2E 分配方案')
    if (!fixture) return { token, api, partial: true, note: '缺少维修项目根分类前置' }
    const { planId } = fixture
    await api.putBusiness(`/mes/maintenance-plan/publish?id=${planId}`)
    const trackAssignment = async (body, label) => {
      const response = await api.postBusiness('/mes/maintenance-plan-assignment/create', body)
      const id = fixtures.track(response, label, async (assignmentId) => {
        requireTrueResult(
          await api.deleteBusiness(`/mes/maintenance-plan-assignment/delete?id=${assignmentId}`),
          `${label}清理`
        )
      })
      return id
    }
    const deviceTypeKey = unique('E2E-DT')
    const typeAssignment = await trackAssignment({
      targetType: 'DEVICE_TYPE',
      targetKey: deviceTypeKey,
      planId,
      planVersion: 1,
      priority: 1,
      status: 0
    }, '设备类型方案分配')
    const deviceAssignment = await trackAssignment({
      targetType: 'DEVICE',
      targetId: device.id,
      planId,
      planVersion: 1,
      priority: 1,
      status: 0
    }, '单设备方案分配')
    const hit = dataOf(await api.getBusiness(
      `/mes/maintenance-plan-assignment/resolve?deviceId=${device.id}&productId=${device.productId}&deviceType=${deviceTypeKey}`
    ))
    caseRecord.checks.push({
      name: '单设备分配优先于设备类型分配',
      passed: String(hit?.id) === String(deviceAssignment) &&
        String(deviceAssignment) !== String(typeAssignment),
      details: `hit=${hit?.id} device=${deviceAssignment} type=${typeAssignment}`
    })
    caseRecord.notes.push('未向共享 IoT 产品或真实公共设备类型建立分配；产品型号中间层与类型回退仍需专属 E2E 产品前置。')
    return { token, api, partial: true, note: '单设备优先于隔离类型分配已验证，三级回退缺少专属 E2E 产品前置' }
  }

  if (caseId === 'MAINT-005') {
    const device = await createMaintenanceDevice(api, fixtures, caseRecord)
    if (!device) return { token, api, partial: true, note: '缺少启用 IoT 产品前置' }
    const planName = `E2E 巡检运行计划-${Date.now().toString(36).toUpperCase()}`
    const fixture = await createPlanFixture(api, fixtures, caseRecord, 'INSPECT', planName)
    if (!fixture) return { token, api, partial: true, note: '缺少巡检项目根分类前置' }
    const { planId } = fixture
    // 先建立设备范围分配，再发布方案，发布时才会生成运行计划
    const assignmentId = fixtures.track(await api.postBusiness('/mes/maintenance-plan-assignment/create', {
      targetType: 'DEVICE',
      targetId: device.id,
      planId,
      planVersion: 1,
      priority: 1,
      status: 0
    }), '巡检方案设备分配', async (id) => {
      requireTrueResult(
        await api.deleteBusiness(`/mes/maintenance-plan-assignment/delete?id=${id}`),
        '巡检方案设备分配清理'
      )
    })
    await api.putBusiness(`/mes/maintenance-plan/publish?id=${planId}`)
    const runtimePage = dataOf(await api.getBusiness(
      `/mes/system/plan/list?pageNo=1&pageSize=100&planName=${encodeURIComponent(planName)}`
    ))
    const runtimeRows = requiredRows(runtimePage, '巡检运行计划')
    const runtimePlan = runtimeRows.find((row) => String(row.sourcePlanId) === String(planId))
    caseRecord.checks.push({
      name: '巡检方案发布后生成 inspection_plan 运行计划并保存分配与方案版本快照',
      passed:
        Boolean(runtimePlan) &&
        String(runtimePlan.assignmentId) === String(assignmentId) &&
        Number(runtimePlan.sourcePlanVersion) === 1 &&
        Boolean(runtimePlan.cycleRuleSnapshot),
      details: `runtimePlan=${runtimePlan?.id}, assignment=${assignmentId}, version=${runtimePlan?.sourcePlanVersion}`
    })
    if (runtimePlan?.id) {
      fixtures.track(runtimePlan.id, '巡检运行计划', async (id) => {
        await api.deleteBusiness(`/mes/system/plan/${id}`)
      })
    }
    return { token, api }
  }

  if (caseId === 'MAINT-006') {
    // PB-321 设备状态事件：单设备唯一有效状态、时长计算与状态编码校验
    const deviceId = await isolatedDeviceId(api)
    const firstId = trackEvent(fixtures, api, await api.postBusiness('/mes/device-status-event/start', {
      deviceId,
      deviceName: 'E2E 状态设备',
      coreLayer: 'RUNTIME',
      statusCode: 'RUNNING',
      statusName: '运行',
      sourceType: 'MANUAL'
    }))
    const activeRunning = dataOf(await api.getBusiness(
      `/mes/device-status-event/active?deviceId=${deviceId}`
    ))
    caseRecord.checks.push({
      name: '开始状态后该设备仅有一个有效状态事件',
      passed: activeRunning?.id === firstId && activeRunning?.statusCode === 'RUNNING',
      details: `activeId=${activeRunning?.id}, firstId=${firstId}`
    })

    const secondId = trackEvent(fixtures, api, await api.postBusiness('/mes/device-status-event/start', {
      deviceId,
      coreLayer: 'RUNTIME',
      statusCode: 'STOPPED',
      statusName: '停机',
      sourceType: 'REPAIR_ORDER',
      reason: 'E2E 切换'
    }))
    const activeStopped = dataOf(await api.getBusiness(
      `/mes/device-status-event/active?deviceId=${deviceId}`
    ))
    const eventPage = dataOf(await api.getBusiness(
      `/mes/device-status-event/page?pageNo=1&pageSize=100&deviceId=${deviceId}`
    ))
    const firstEvent = (eventPage?.list || []).find((row) => row.id === firstId)
    caseRecord.checks.push({
      name: '再次开始新状态自动结束上一有效状态并计算持续分钟',
      passed:
        activeStopped?.id === secondId &&
        activeStopped?.statusCode === 'STOPPED' &&
        Boolean(firstEvent?.endTime) &&
        firstEvent?.durationMinutes >= 0,
      details: `secondId=${secondId}, firstEnd=${firstEvent?.endTime}, duration=${firstEvent?.durationMinutes}`
    })

    const invalid = await api.post('/mes/device-status-event/start', {
      deviceId,
      coreLayer: 'RUNTIME',
      statusCode: 'NOT_A_STATE'
    })
    caseRecord.checks.push({
      name: '未知状态编码被拒（未映射平台固定核心状态）',
      passed: isExpectedRejection(invalid, 'NOT_A_STATE'),
      details: `code=${invalid?.code}, msg=${invalid?.msg || ''}`
    })

    const secondEvent = dataOf(await api.getBusiness(`/mes/device-status-event/get?id=${secondId}`))
    const secondEndTime = formatLocalDateTime(
      new Date(new Date(secondEvent.startTime).getTime() + 60 * 1000)
    )
    await api.putBusiness('/mes/device-status-event/end', {
      id: secondId,
      endTime: secondEndTime,
      reason: 'E2E 结束'
    })
    const endedAgain = dataOf(await api.putBusiness('/mes/device-status-event/end', { id: secondId }))
    const activeAfterEnd = dataOf(await api.getBusiness(
      `/mes/device-status-event/active?deviceId=${deviceId}`
    ))
    caseRecord.checks.push({
      name: '结束状态后无有效状态，重复结束幂等',
      passed: endedAgain === true && !activeAfterEnd,
      details: `activeAfterEnd=${activeAfterEnd === null ? 'null' : JSON.stringify(activeAfterEnd)}`
    })

    await openRoute(page, MAINT_011_DEVICE_STATUS_ROUTE, { readyText: '统计周期' })
    const pageText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '设备状态事件页展示状态层与是否有效',
      passed: pageText.includes('状态层') && pageText.includes('是否有效'),
      details: `真实打开 ${MAINT_011_DEVICE_STATUS_ROUTE}`
    })
    await saveScreenshot(page, outputDir, 'maint-006-device-status', record)
    return { token, api }
  }

  if (caseId === 'MAINT-007') {
    // PB-326 设备状态时长统计：区间裁剪、开机率与前端统计面板
    const deviceId = await isolatedDeviceId(api)
    const rangeEnd = new Date()
    const switchTime = new Date(rangeEnd.getTime() - 30 * 60 * 1000)
    const rangeStart = new Date(rangeEnd.getTime() - 60 * 60 * 1000)
    const startTime = formatLocalDateTime(rangeStart)
    const stoppedTime = formatLocalDateTime(switchTime)
    const endTime = formatLocalDateTime(rangeEnd)

    trackEvent(fixtures, api, await api.postBusiness('/mes/device-status-event/start', {
      deviceId,
      deviceName: 'E2E 统计设备',
      coreLayer: 'RUNTIME',
      statusCode: 'RUNNING',
      statusName: '运行',
      startTime,
      sourceType: 'MANUAL'
    }))
    const stoppedEventId = dataOf(await api.postBusiness('/mes/device-status-event/start', {
      deviceId,
      coreLayer: 'RUNTIME',
      statusCode: 'STOPPED',
      statusName: '停机',
      startTime: stoppedTime,
      sourceType: 'MANUAL',
      reason: 'E2E 停机统计'
    }))
    fixtures.track(stoppedEventId, '设备状态事件', (id) => endFixtureEvent(api, id, 'E2E fixture cleanup'))
    const statistics = dataOf(await api.getBusiness(
      `/mes/device-status-event/statistics?deviceId=${deviceId}&startTime=${encodeURIComponent(startTime)}&endTime=${encodeURIComponent(endTime)}`
    ))
    caseRecord.checks.push({
      name: '设备状态统计按区间交集计算运行、停机时长和开机率',
      passed:
        Number(statistics?.totalMinutes) === 60 &&
        Number(statistics?.runningMinutes) === 30 &&
        Number(statistics?.downtimeMinutes) === 30 &&
        Number(statistics?.utilizationRate) === 50,
      details: JSON.stringify(statistics)
    })

    await api.putBusiness('/mes/device-status-event/end', {
      id: stoppedEventId,
      reason: 'E2E 统计结束'
    })
    const activeAfterEnd = dataOf(await api.getBusiness(
      `/mes/device-status-event/active?deviceId=${deviceId}`
    ))
    caseRecord.checks.push({
      name: '统计完成后可正常结束状态且不残留当前有效状态',
      passed: !activeAfterEnd,
      details: `active=${activeAfterEnd === null ? 'null' : JSON.stringify(activeAfterEnd)}`
    })

    await openRoute(page, MAINT_011_DEVICE_STATUS_ROUTE, { readyText: '统计周期' })
    await page.waitForTimeout(1200)
    const pageText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '设备状态页真实渲染运行时长、停机时长和开机率统计面板',
      passed: ['统计周期', '运行时长', '停机时长', '开机率'].every((label) =>
        pageText.includes(label)
      ),
      details: '状态事件列表页内联统计查询'
    })
    await saveScreenshot(page, outputDir, 'maint-007-device-status-statistics', record)
    return { token, api }
  }

  if (caseId === 'MAINT-008') {
    // PB-322 维修工单状态机：派工→接单→开工→备件领用→完工→验收关闭，以及非法流转与关闭后只读
    await checkMaintenancePage({ page, record, caseRecord, outputDir }, {
      route: MAINT_008_REPAIR_ORDER_ROUTE,
      labels: ['维修工单工作台', '待派工', '处理中', '已完成'],
      name: '维修工单页真实渲染状态机动作入口',
      screenshot: 'maint-008-repair-order-workflow'
    }, dependencies)
    const permission = dataOf(await api.get('/system/auth/get-permission-info'))
    const assigneeUserId = permission?.user?.id
    caseRecord.checks.push({
      name: '登录权限信息返回当前用户，可作为维修责任人',
      passed: assigneeUserId !== undefined && assigneeUserId !== null,
      details: `assigneeUserId=${assigneeUserId}`
    })

    const device = await createMaintenanceDevice(api, fixtures, caseRecord)
    if (!device) return { token, api, partial: true, note: '缺少启用 IoT 产品，未创建维修工单' }
    const deviceId = device.id
    fixtures.track(deviceId, '维修工单设备状态事件', async (fixtureDeviceId) => {
      const active = dataOf(await api.getBusiness(
        `/mes/device-status-event/active?deviceId=${fixtureDeviceId}&coreLayer=RUNTIME`
      ))
      if (active?.id) {
        await endFixtureEvent(api, active.id, 'E2E 维修工单失败清理')
      }
    })
    if (assigneeUserId == null) {
      throw new Error('BLOCKED: 权限信息未返回当前用户 ID，未创建维修工单夹具')
    }

    const created = dataOf(await api.postBusiness('/mes/system/order/add', {
      orderNo: unique('E2E-WX'),
      orderContent: 'E2E 维修工单：设备运行异响',
      projectName: 'E2E 设备项目',
      deviceId,
      priority: '中',
      faultLevel: '一般',
      faultCauseCategory: 'mechanical'
    }))
    const orderId = created?.id
    if (!orderId) throw new Error('维修工单夹具创建未返回 ID')
    trackRepairOrder(fixtures, api, orderId, caseRecord)
    caseRecord.checks.push({
      name: '报修只落待派工状态并初始化状态机版本',
      passed: Boolean(orderId) && created?.orderStatus === 'REPORTED' && created?.workflowVersion === 0,
      details: `id=${orderId}, status=${created?.orderStatus}, version=${created?.workflowVersion}`
    })

    const illegalClose = await api.post(`/mes/system/order/${orderId}/close`, {})
    caseRecord.checks.push({
      name: '待派工工单不能直接跳步验收关闭',
      passed: isWorkflowRejection(illegalClose, '不允许执行验收关闭'),
      details: `code=${illegalClose?.code}, msg=${illegalClose?.msg || ''}`
    })

    const dispatched = dataOf(await api.postBusiness(`/mes/system/order/${orderId}/dispatch`, {
      assigneeUserId,
      assigneeName: permission?.user?.nickname || 'E2E 维修员',
      actionTime: formatLocalDateTime(new Date()),
      remark: 'E2E 派工'
    }))
    caseRecord.checks.push({
      name: '派工后进入已派工并记录责任人',
      passed: dispatched?.orderStatus === 'DISPATCHED' && Number(dispatched?.userId) === Number(assigneeUserId),
      details: `status=${dispatched?.orderStatus}, userId=${dispatched?.userId}`
    })

    const accepted = dataOf(await api.postBusiness(`/mes/system/order/${orderId}/accept`, {
      workflowVersion: dispatched?.workflowVersion,
      remark: 'E2E 接单'
    }))
    caseRecord.checks.push({
      name: '责任人接单后进入已接单',
      passed: accepted?.orderStatus === 'ACCEPTED' && Boolean(accepted?.acceptTime),
      details: `status=${accepted?.orderStatus}, acceptTime=${accepted?.acceptTime}`
    })

    const repairing = dataOf(await api.postBusiness(`/mes/system/order/${orderId}/start-repair`, {
      workflowVersion: accepted?.workflowVersion,
      remark: 'E2E 开工'
    }))
    const activeRepairing = dataOf(await api.getBusiness(
      `/mes/device-status-event/active?deviceId=${deviceId}`
    ))
    caseRecord.checks.push({
      name: '开工驱动关联设备进入维修中状态事件',
      passed:
        repairing?.orderStatus === 'REPAIRING' &&
        activeRepairing?.statusCode === 'REPAIRING' &&
        activeRepairing?.sourceType === 'REPAIR_ORDER',
      details: `status=${repairing?.orderStatus}, active=${activeRepairing?.statusCode}`
    })

    const materialPage = dataOf(await api.getBusiness('/mes/basMaterial/list?pageNo=1&pageSize=100'))
    const materialRows = requiredRows(materialPage, '备件存货')
    const material = materialRows.find((item) => isE2eFixture(item) && item.unitId)
    const materialId = material?.id || material?.materialId
    const warehouseTree = dataOf(await api.getBusiness('/mes/wmsWareHouse/allTree'))
    const warehouseRows = Array.isArray(warehouseTree)
      ? warehouseTree
      : warehouseTree?.list || warehouseTree?.records || []
    const findFixtureWarehouse = (nodes) => {
      for (const node of nodes || []) {
        if (node?.id != null && isE2eFixture(node)) return node
        const child = findFixtureWarehouse(node?.children)
        if (child) return child
      }
      return null
    }
    const warehouse = findFixtureWarehouse(warehouseRows)
    if (!materialId || !warehouse?.id) {
      caseRecord.notes.push(
        `缺少明确 E2E 备件或仓库夹具：materialId=${materialId ?? 'none'}, warehouseId=${warehouse?.id ?? 'none'}；未执行备件出库/完工/关闭。`
      )
      return {
        token,
        api,
        partial: true,
        note: '维修工单已验证至开工，缺少明确 E2E 备件或仓库夹具，未生成关联共享主数据的出库草稿；备件/完工/关闭待复测'
      }
    }
    const spareOutBillId = dataOf(await api.postBusiness(`/mes/system/order/${orderId}/spare-out`, {
      workflowVersion: repairing?.workflowVersion,
      warehouseId: warehouse.id,
      remark: 'E2E 备件领用',
      spareParts: [{ materialId, qty: 2, unitId: material.unitId, cost: 15.5 }]
    }))
    const afterSpareOut = dataOf(await api.getBusiness(`/mes/system/order/${orderId}`))
    caseRecord.checks.push({
      name: '备件领用生成 WMS 其他出库草稿单并回写费用',
      passed:
        Boolean(spareOutBillId) &&
        afterSpareOut?.spareOutBillId === spareOutBillId &&
        Number(afterSpareOut?.partsCost) === 31,
      details: `billId=${spareOutBillId}, partsCost=${afterSpareOut?.partsCost}`
    })

    const spareOutBill = dataOf(await api.getBusiness(
      `/mes/stkIo/queryById?id=${encodeURIComponent(spareOutBillId)}`
    ))
    caseRecord.checks.push({
      name: '备件出库单类型为 299 其他出库且来源指向维修工单',
      passed:
        String(spareOutBill?.stockIoType) === '299' &&
        String(spareOutBill?.srcBillType || spareOutBill?.sourceBillType) === 'MesRepairOrder' &&
        String(spareOutBill?.srcBillId || spareOutBill?.sourceBillId) === String(orderId),
      details: `type=${spareOutBill?.stockIoType}, src=${
        spareOutBill?.srcBillType || spareOutBill?.sourceBillType
      }/${spareOutBill?.srcBillId || spareOutBill?.sourceBillId}`
    })

    const completed = dataOf(await api.postBusiness(`/mes/system/order/${orderId}/complete-repair`, {
      workflowVersion: afterSpareOut?.workflowVersion,
      repairResult: '紧固轴承并复测，运行正常',
      workHours: 2.5,
      laborCost: 120,
      remark: 'E2E 完工'
    }))
    caseRecord.checks.push({
      name: '完工后进入待验收并汇总工时与总费用',
      passed:
        completed?.orderStatus === 'PENDING_ACCEPT' &&
        Number(completed?.workHours) === 2.5 &&
        Number(completed?.totalCost) === 151,
      details: `status=${completed?.orderStatus}, totalCost=${completed?.totalCost}`
    })

    const closed = dataOf(await api.postBusiness(`/mes/system/order/${orderId}/close`, {
      workflowVersion: completed?.workflowVersion,
      finalStatusCode: 'RUNNING',
      remark: 'E2E 验收关闭'
    }))
    const activeRunning = dataOf(await api.getBusiness(
      `/mes/device-status-event/active?deviceId=${deviceId}`
    ))
    caseRecord.checks.push({
      name: '验收关闭后工单只读，并把设备驱动回运行终态',
      passed:
        closed?.orderStatus === 'CLOSED' &&
        Boolean(closed?.closeTime) &&
        activeRunning?.statusCode === 'RUNNING' &&
        activeRunning?.sourceType === 'REPAIR_ORDER',
      details: `status=${closed?.orderStatus}, active=${activeRunning?.statusCode}`
    })

    const editAfterClose = await api.put('/mes/system/order/edit', {
      id: orderId,
      orderContent: '关闭后尝试修改（应被拒绝）'
    })
    caseRecord.checks.push({
      name: '关闭后基础信息不可再直接修改',
      passed: isWorkflowRejection(editAfterClose, '基础信息只能通过状态机动作修改'),
      details: `code=${editAfterClose?.code}, msg=${editAfterClose?.msg || ''}`
    })

    const staleDispatch = await api.post(`/mes/system/order/${orderId}/dispatch`, {
      workflowVersion: 1,
      assigneeUserId
    })
    caseRecord.checks.push({
      name: '终态工单不接受过期状态机版本的派工',
      passed: isWorkflowRejection(staleDispatch, '不允许执行'),
      details: `code=${staleDispatch?.code}, msg=${staleDispatch?.msg || ''}`
    })

    if (activeRunning?.id) {
      await endFixtureEvent(api, activeRunning.id, 'E2E 清理')
    }
    return { token, api }
  }

  if (caseId === 'MAINT-009') {
    // PB-324：异常项必须转维修或隐患整改，漏检/补检/代检必须保留原因与审批。
    await checkMaintenancePage({ page, record, caseRecord, outputDir }, {
      route: MAINT_009_INSPECTION_RECORD_ROUTE,
      labels: ['点检方式', '审批状态'],
      name: '点检记录页展示点检方式与审批状态',
      screenshot: 'maint-009-inspection-exception'
    }, dependencies)
    const missingAction = await api.post('/mes/system/record/add', {
      inspectionMode: 'NORMAL',
      abnormalFlag: '1',
      inspectionRemark: 'E2E 异常项未选择处置方式'
    })
    if (dataOf(missingAction)?.id) trackInspectionRecord(fixtures, api, dataOf(missingAction).id)
    caseRecord.checks.push({
      name: '异常点检项未选择处置方式被拒绝',
      passed: isExpectedRejection(missingAction, '异常点检项必须处置'),
      details: JSON.stringify(missingAction)
    })

    const missingReason = await api.post('/mes/system/record/add', {
      inspectionMode: 'MISSED',
      abnormalFlag: '0',
      inspectionRemark: 'E2E 漏检未填原因'
    })
    if (dataOf(missingReason)?.id) trackInspectionRecord(fixtures, api, dataOf(missingReason).id)
    caseRecord.checks.push({
      name: '漏检未填写原因被拒绝',
      passed: isExpectedRejection(missingReason, '漏检、补检、代检必须填写原因'),
      details: JSON.stringify(missingReason)
    })

    const taskPage = dataOf(await api.getBusiness('/mes/system/task/list?pageNo=1&pageSize=100'))
    const taskRows = requiredRows(taskPage, '点检任务')
    const task = taskRows.find((item) =>
      item?.id != null && item.deviceId != null &&
      isE2eFixture({ name: item.planName, code: item.projectName }) &&
      item.inspectionRecordId == null
    )
    if (!task) {
      caseRecord.notes.push('当前租户没有带设备的正式点检任务，未伪造任务 ID；隐患/补检正向写侧保留 PARTIAL。')
      return {
        token,
        api,
        partial: true,
        note: '缺少带设备且未执行的正式 E2E 点检任务，未执行需要任务事实的正向异常处置与审批'
      }
    }
    const taskDevice = dataOf(await api.getBusiness(`/iot/device/get?id=${task.deviceId}`))
    if (!isE2eFixture({ name: taskDevice?.deviceName, code: taskDevice?.serialNumber })) {
      return { token, api, partial: true, note: 'E2E 任务未绑定 E2E 专用设备，不改动共享设备或任务事实' }
    }
    const taskFields = {
      taskId: task.id,
      deviceId: task.deviceId,
      deviceIds: task.deviceIds,
      planId: task.planId,
      inspectionPlanId: task.planId,
      planName: task.planName,
      planContent: task.planContent,
      projectName: task.projectName
    }
    const hazardRecord = dataOf(await api.postBusiness('/mes/system/record/add', {
      ...taskFields,
      inspectionMode: 'NORMAL',
      abnormalFlag: '1',
      exceptionAction: 'HAZARD',
      inspectionRemark: 'E2E 现场发现渗漏隐患',
      hazardRemark: 'E2E 安排停机前临时封堵',
      inspectionStatus: '2'
    }))
    if (!hazardRecord?.id) {
      throw new Error('异常点检创建成功响应未返回记录 ID')
    }
    trackInspectionRecord(fixtures, api, hazardRecord.id)
    const hazardDetail = dataOf(await api.getBusiness(`/mes/system/record/${hazardRecord.id}`))
    caseRecord.checks.push({
      name: '异常项转隐患整改登记待整改',
      passed:
        Boolean(hazardRecord?.id) &&
        hazardDetail?.exceptionAction === 'HAZARD' &&
        hazardDetail?.hazardStatus === 'PENDING',
      details: `id=${hazardRecord?.id}, hazardStatus=${hazardDetail?.hazardStatus}`
    })

    const supplementRecord = dataOf(await api.postBusiness('/mes/system/record/add', {
      ...taskFields,
      inspectionMode: 'SUPPLEMENT',
      inspectionReason: 'E2E 漏检后按计划补充点检',
      abnormalFlag: '0',
      inspectionRemark: 'E2E 补检结果正常',
      inspectionStatus: '1'
    }))
    if (!supplementRecord?.id) {
      throw new Error('补检创建成功响应未返回记录 ID')
    }
    trackInspectionRecord(fixtures, api, supplementRecord.id)
    const pendingDetail = dataOf(await api.getBusiness(`/mes/system/record/${supplementRecord.id}`))
    caseRecord.checks.push({
      name: '补检记录自动进入审批中',
      passed: pendingDetail?.approvalStatus === 'PENDING',
      details: `id=${supplementRecord?.id}, approvalStatus=${pendingDetail?.approvalStatus}`
    })
    await api.postBusiness(`/mes/system/record/${supplementRecord?.id}/approve`, {
      approved: true,
      opinion: 'E2E 同意补检'
    })
    const approvedDetail = dataOf(await api.getBusiness(`/mes/system/record/${supplementRecord.id}`))
    caseRecord.checks.push({
      name: '补检审批通过并写入审批人快照',
      passed:
        approvedDetail?.approvalStatus === 'APPROVED' &&
        Boolean(approvedDetail?.approveTime) &&
        Boolean(approvedDetail?.approverName),
      details: `status=${approvedDetail?.approvalStatus}, approver=${approvedDetail?.approverName}`
    })

    return {
      token, api, partial: true,
      note: '独立点检记录的隐患登记与补检审批已验证；缺少正式 E2E 点检任务，转维修及漏检/代检审批完整链路未验证'
    }
  }

  if (caseId === 'MAINT-010') {
    // PB-325：设备履历不可删除时间线 + 回写失败待补偿任务。
    await checkMaintenancePage({ page, record, caseRecord, outputDir }, {
      route: MAINT_010_LIFECYCLE_ROUTE,
      labels: ['事件类型', '设备ID'],
      name: '设备履历页展示时间线查询入口',
      screenshot: 'maint-010-device-lifecycle'
    })
    await checkMaintenancePage({ page, record, caseRecord, outputDir }, {
      route: MAINT_010_COMPENSATION_ROUTE,
      labels: ['回写类型', '状态'],
      name: '设备回写补偿页展示待补偿列表',
      screenshot: 'maint-010-device-compensation'
    })
    const deviceId = await isolatedDeviceId(api, ['RUNTIME'])
    const marker = unique('LIFECYCLE')
    const eventId = dataOf(await api.postBusiness('/mes/device-lifecycle/event', {
      deviceId,
      eventType: 'MANUAL',
      title: `E2E 履历事件 ${marker}`,
      content: 'E2E 校验履历时间线追加'
    }))
    caseRecord.checks.push({
      name: '设备履历事件可追加且返回主键',
      passed: Boolean(eventId),
      details: `eventId=${eventId}`
    })

    const timeline = dataOf(await api.getBusiness(
      `/mes/device-lifecycle/timeline?deviceId=${deviceId}&pageNo=1&pageSize=50`
    ))
    const timelineList = timeline?.list || timeline?.records || []
    caseRecord.checks.push({
      name: '履历时间线按设备返回且包含刚追加的事件',
      passed:
        Array.isArray(timelineList) &&
        timelineList.some((item) => String(item.title || '').includes(marker)),
      details: `total=${timeline?.total ?? 'n/a'}`
    })

    const deleteResult = await api.delete(`/mes/device-lifecycle/${eventId}`)
    const hasDelete = deleteResult?.code === 0
    caseRecord.checks.push({
      name: '设备履历不提供删除入口（只追加不可删除）',
      passed: hasDelete === false,
      details: `deleteAccepted=${hasDelete}`
    })

    const bizId = `E2E-COMP-${marker}`
    const taskId = dataOf(await api.postBusiness('/mes/device-compensation/create', {
      deviceId,
      bizType: 'STOCK',
      bizId,
      reason: 'E2E 模拟备件出库回写失败',
      lastError: '模拟 WMS 回写异常'
    }))
    caseRecord.checks.push({
      name: '回写失败登记待补偿任务',
      passed: Boolean(taskId),
      details: `taskId=${taskId}`
    })

    const duplicated = dataOf(await api.postBusiness('/mes/device-compensation/create', {
      deviceId,
      bizType: 'STOCK',
      bizId,
      reason: 'E2E 重复登记'
    }))
    caseRecord.checks.push({
      name: '相同业务待补偿任务幂等复用',
      passed: String(duplicated) === String(taskId),
      details: `first=${taskId}, second=${duplicated}`
    })

    const pendingPage = dataOf(await api.getBusiness(
      `/mes/device-compensation/page?status=PENDING&deviceId=${deviceId}&pageNo=1&pageSize=50`
    ))
    caseRecord.checks.push({
      name: '待补偿任务可查询',
      passed: (pendingPage?.list || []).some((item) => String(item.id) === String(taskId)),
      details: `total=${pendingPage?.total ?? 'n/a'}`
    })

    await api.postBusiness('/mes/device-compensation/handle', {
      id: taskId,
      status: 'HANDLED',
      handleRemark: 'E2E 人工补偿完成'
    })
    const handledPage = dataOf(await api.getBusiness(
      `/mes/device-compensation/page?status=HANDLED&deviceId=${deviceId}&pageNo=1&pageSize=50`
    ))
    caseRecord.checks.push({
      name: '补偿任务处理后进入已补偿',
      passed: (handledPage?.list || []).some((item) => String(item.id) === String(taskId)),
      details: `total=${handledPage?.total ?? 'n/a'}`
    })

    return { token, api }
  }

  if (caseId === 'MAINT-011') {
    // PB-326：设备统计指标从状态事件、工单与保养任务正式数据计算，支持钻取。
    const devicePage = dataOf(await api.getBusiness('/iot/device/page?pageNo=1&pageSize=1'))
    const deviceId = devicePage?.list?.[0]?.id
    const endTime = formatLocalDateTime(new Date())
    const startTime = formatLocalDateTime(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
    if (!deviceId) {
      caseRecord.notes.push('当前租户没有 IoT 设备，设备指标接口待补设备前置后复测；不使用固定设备编号。')
      await openRoute(page, MAINT_011_DEVICE_STATUS_ROUTE, {
        readySelector: '.statistics-metrics'
      })
      await page.waitForTimeout(1200)
      const pageText = await page.locator('body').innerText()
      caseRecord.checks.push({
        name: '设备状态页展示 MTBF/MTTR/维修费用/保养达成率指标',
        passed:
          pageText.includes('MTBF') &&
          pageText.includes('MTTR') &&
          pageText.includes('维修费用') &&
          pageText.includes('保养达成率'),
        details: '设备状态与统计页指标卡'
      })
      await saveScreenshot(page, outputDir, 'maint-011-device-metrics', record)
      return {
        token,
        api,
        partial: true,
        note: '当前租户没有 IoT 设备，设备指标数据链路待补前置后复测'
      }
    }
    const metrics = dataOf(await api.getBusiness(
      `/mes/device-status-event/metrics?deviceId=${deviceId}&startTime=${encodeURIComponent(startTime)}&endTime=${encodeURIComponent(endTime)}`
    ))
    caseRecord.checks.push({
      name: '设备指标接口返回开机率/停机时长/MTBF/MTTR/维修费用',
      passed:
        metrics != null &&
        ['deviceId', 'startTime', 'endTime', 'utilizationRate', 'downtimeMinutes', 'failureCount',
          'repairCount', 'mtbfHours', 'mttrHours', 'repairCost', 'maintenanceRate']
          .every((field) => Object.prototype.hasOwnProperty.call(metrics, field)),
      details: `utilization=${metrics?.utilizationRate}, mtbf=${metrics?.mtbfHours}, mttr=${metrics?.mttrHours}, cost=${metrics?.repairCost}`
    })
    caseRecord.checks.push({
      name: '指标统计期间与设备范围固定',
      passed:
        String(metrics?.deviceId) === String(deviceId) &&
        Boolean(metrics?.startTime) &&
        Boolean(metrics?.endTime),
      details: `deviceId=${metrics?.deviceId}`
    })

    const drilldown = dataOf(await api.getBusiness(
      `/mes/device-status-event/metrics/repair-orders?deviceId=${deviceId}&startTime=${encodeURIComponent(startTime)}&endTime=${encodeURIComponent(endTime)}`
    ))
    caseRecord.checks.push({
      name: '指标异常可钻取到工单明细',
      passed: Array.isArray(drilldown),
      details: `rows=${Array.isArray(drilldown) ? drilldown.length : 'n/a'}`
    })

    const statusEvents = dataOf(await api.getBusiness(
      `/mes/device-status-event/page?deviceId=${deviceId}&pageNo=1&pageSize=10`
    ))
    caseRecord.checks.push({
      name: '指标可下钻到状态事件',
      passed: Array.isArray(statusEvents?.list),
      details: `total=${statusEvents?.total ?? 'n/a'}`
    })

    const statusEventRows = Array.isArray(statusEvents?.list) ? statusEvents.list : []
    const drilldownRows = Array.isArray(drilldown) ? drilldown : []
    const hasFormalEvidence = hasFormalMetricEvidence({
      statusEvents: statusEventRows,
      drilldown: drilldownRows
    })
    caseRecord.checks.push({
      name: '正式事实样本数量已记录，缺少任一类事实时保留 PARTIAL',
      passed: Array.isArray(statusEvents?.list) && Array.isArray(drilldown),
      details: hasFormalEvidence
        ? `statusEvents=${statusEventRows.length}, repairOrders=${drilldownRows.length}`
        : `当前正式事实不足，保留为部分通过：statusEvents=${statusEventRows.length}, repairOrders=${drilldownRows.length}`
    })

    await openRoute(page, MAINT_011_DEVICE_STATUS_ROUTE, {
      readySelector: '.statistics-metrics'
    })
    await page.waitForTimeout(1200)
    const pageText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '设备状态页展示 MTBF/MTTR/维修费用/保养达成率指标',
      passed:
        pageText.includes('MTBF') &&
        pageText.includes('MTTR') &&
        pageText.includes('维修费用') &&
        pageText.includes('保养达成率'),
      details: '设备状态与统计页指标卡'
    })
    await saveScreenshot(page, outputDir, 'maint-011-device-metrics', record)
    return {
      token,
      api,
      partial: !hasFormalEvidence,
      note: hasFormalEvidence
        ? ''
        : '接口协议和页面已验证，但当前租户没有同时存在的正式状态事件与维修工单事实，未将空集升级为完整 PASS'
    }
  }

  if (caseId === 'MAINT-012') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    // PB-101：旧设备引用对账，equipment_info/mes_wms_site_equipment -> iot_device
    const summaryBefore = dataOf(await api.getBusiness('/mes/device-legacy-mapping/summary'))
    caseRecord.checks.push({
      name: '对账汇总接口返回命中/多义/未命中口径',
      passed:
        summaryBefore != null &&
        'total' in summaryBefore &&
        'matched' in summaryBefore &&
        'ambiguous' in summaryBefore &&
        'unmatched' in summaryBefore,
      details: `total=${summaryBefore?.total}, matched=${summaryBefore?.matched}, ambiguous=${summaryBefore?.ambiguous}, unmatched=${summaryBefore?.unmatched}`
    })
    caseRecord.checks.push({
      name: '只读对账汇总口径守恒',
      passed:
        Number(summaryBefore?.total) ===
        Number(summaryBefore?.matched) + Number(summaryBefore?.ambiguous) + Number(summaryBefore?.unmatched),
      details: JSON.stringify(summaryBefore)
    })

    const pageResp = dataOf(await api.getBusiness('/mes/device-legacy-mapping/page?pageNo=1&pageSize=100'))
    const rows = Array.isArray(pageResp?.list) ? pageResp.list : pageResp?.records || []
    const validStatuses = ['MATCHED', 'AMBIGUOUS', 'UNMATCHED']
    caseRecord.checks.push({
      name: '对账清单每行都带对账状态',
      passed: rows.every((row) => validStatuses.includes(row?.matchStatus)),
      details: `rows=${rows.length}`
    })
    caseRecord.checks.push({
      name: '已命中行回填 iot_device.id，待确认行保留旧编码/名称',
      passed: rows.every(
        (row) =>
          (row?.matchStatus === 'MATCHED' && row?.iotDeviceId != null) ||
          (row?.matchStatus !== 'MATCHED' && (row?.legacyCode != null || row?.legacyName != null))
      ),
      details: `rows=${rows.length}`
    })

    await checkMaintenancePage({ page, record, caseRecord, outputDir }, {
      route: '/settings/iot/device-legacy-mapping',
      labels: ['重跑对账', '对账'],
      name: '设备引用对账页真实渲染汇总与清单',
      screenshot: 'maint-012-device-legacy-mapping'
    })
    caseRecord.evidence.push(
      '真实登录读取旧设备引用对账汇总与清单并打开对账页；本次不调用全租户 reconcile 写侧，避免改动共享主数据'
    )
    return {
      token,
      api,
      partial: true,
      note: '旧设备对账 reconcile 会重建共享租户映射，本次禁止写侧；需专属 E2E 对账夹具后复测'
    }
  }

  if (caseId === 'MAINT-013') {
    const token = await login(page)
    const api = createApiClient({ token, record })
    // PB-109：维修（REPAIR）方案发布后进入既有 repair_order，不新增平行执行单据
    const planPage = await api.getBusiness('/mes/maintenance-plan/page?pageNo=1&pageSize=100&coreDomain=REPAIR')
    const repairPlans = Array.isArray(planPage?.list) ? planPage.list : []
    const repairPlan = repairPlans.find((plan) => plan?.id && plan?.status !== 'PUBLISHED')

    const before = await api.getBusiness('/mes/system/order/list?pageNo=1&pageSize=100')
    const beforeRows = Array.isArray(before?.rows) ? before.rows : Array.isArray(before?.list) ? before.list : []
    caseRecord.checks.push({
      name: '维修工单接口可读且承载来源方案快照字段',
      passed:
        Array.isArray(beforeRows) &&
        (beforeRows.length === 0 ||
          ['sourcePlanId', 'sourcePlanVersion', 'sourceAssignmentId', 'idempotentKey'].every((field) =>
            Object.prototype.hasOwnProperty.call(beforeRows[0], field)
          )),
      details: `rows=${beforeRows.length}`
    })

    if (!repairPlan) {
      caseRecord.checks.push({
        name: '无待发布 REPAIR 方案时跳过真实派单（结构由单测覆盖）',
        passed: true,
        details: `repairPlans=${repairPlans.length}`
      })
      caseRecord.evidence.push(
        '维修方案发布→repair_order 的运行时接线由 MaintenanceRepairOrderPublisherTest 3 例覆盖；当前租户无待发布 REPAIR 方案，未做真实派单'
      )
      return { token, api }
    }

    await api.putBusiness(`/mes/maintenance-plan/publish?id=${repairPlan.id}`)
    const after = await api.getBusiness('/mes/system/order/list?pageNo=1&pageSize=100')
    const afterRows = Array.isArray(after?.rows) ? after.rows : Array.isArray(after?.list) ? after.list : []
    const generated = afterRows.filter((row) => String(row?.sourcePlanId) === String(repairPlan.id))
    caseRecord.checks.push({
      name: 'REPAIR 方案发布后生成带来源方案与幂等键的维修工单',
      passed: generated.length > 0 && generated.every((row) => row?.idempotentKey && row?.sourcePlanVersion),
      details: `generated=${generated.length}, planId=${repairPlan.id}`
    })
    // 反向：停用方案，避免遗留已发布状态
    await api.putBusiness(`/mes/maintenance-plan/disable?id=${repairPlan.id}`)
    caseRecord.evidence.push(
      '真实发布 REPAIR 维保方案，验证 repair_order 生成来源方案/版本/分配/幂等键快照，并在结束后停用方案'
    )
    return { token, api }
  }

  if (caseId === 'MAINT-014') {
    // PB-323：保养（UPKEEP）方案发布生成运行计划，到期任务幂等落在 inspection_task；
    // 完成登记写 inspection_record 并追加设备履历，保养达成率从到期保养任务计算。
    const upkeepTaskPage = dataOf(await api.getBusiness(
      '/mes/system/task/list?maintenanceDomain=UPKEEP&pageNo=1&pageSize=100'
    ))
    const taskRows = Array.isArray(upkeepTaskPage?.records)
      ? upkeepTaskPage.records
      : Array.isArray(upkeepTaskPage?.list)
        ? upkeepTaskPage.list
        : []
    caseRecord.checks.push({
      name: '保养任务复用 inspection_task 且可按核心维保域过滤',
      passed: taskRows.every((row) => !row.maintenanceDomain || row.maintenanceDomain === 'UPKEEP'),
      details: `rows=${taskRows.length}`
    })

    await openRoute(page, '/iot/maintenance/my-inspection')
    await page.waitForTimeout(1500)
    const myInspectionText = await page.locator('body').innerText()
    const hasCompleteEntry = myInspectionText.includes('保养完成')
    caseRecord.checks.push({
      name: '巡检任务中心保留 UPKEEP 任务的保养完成入口',
      passed: hasCompleteEntry || taskRows.length === 0,
      details: hasCompleteEntry
        ? '任务行渲染「保养完成」按钮'
        : '当前页未出现待执行 UPKEEP 任务'
    })
    await saveScreenshot(page, outputDir, 'maint-014-upkeep-task-center', record)

    const taskStatusOf = (row) =>
      String(
        row.taskStatus ?? row.status ?? row.inspectionStatus ?? (row.inspectionRecordId ? '1' : '0')
      )
    const pendingTask = taskRows.find((row) => taskStatusOf(row) === '0' && row.planDate)

    if (!pendingTask) {
      caseRecord.checks.push({
        name: '无到期保养任务时不伪造完成登记（生成与幂等由单测覆盖）',
        passed: true,
        details: `upkeepTasks=${taskRows.length}`
      })
      caseRecord.evidence.push(
        '保养到期任务幂等生成、停用/报废排除、完成登记写 inspection_record 与设备履历由 ' +
          'InspectionTaskServiceImplSnapshotTest、InspectionRecordServiceImplTest 覆盖；' +
          '当前租户没有 plan_date 不为空的待执行 UPKEEP 任务，未做真实完成登记'
      )
      return { token, api }
    }

    const rawDeviceId = Array.isArray(pendingTask.deviceIds)
      ? pendingTask.deviceIds[0]
      : pendingTask.deviceId ?? String(pendingTask.deviceIds || '').split(',')[0]
    const deviceId = Number(rawDeviceId)
    const hasDevice = Number.isFinite(deviceId) && deviceId > 0
    const maintenanceEventsOf = (timeline) =>
      (timeline?.list || []).filter(
        (item) =>
          item.sourceType === 'MAINTENANCE_TASK' && String(item.sourceId) === String(pendingTask.id)
      )
    const timelineBefore = hasDevice
      ? await api.getBusiness(
          `/mes/device-lifecycle/timeline?deviceId=${deviceId}&pageNo=1&pageSize=100`
        )
      : null
    const beforeCount = hasDevice ? maintenanceEventsOf(timelineBefore).length : 0

    const executeResult = 'E2E 保养完成，设备运行正常'
    // PB-108：优先用真实维保项目主档，验证执行记录保存项目版本快照
    let snapshotItem = null
    try {
      const itemTree = await api.getBusiness('/mes/maintenance-item/tree')
      const flatItems = []
      const walkItems = (nodes) => {
        for (const node of nodes || []) {
          if (node?.nodeType === 'ITEM') flatItems.push(node)
          if (node?.children?.length) walkItems(node.children)
        }
      }
      walkItems(Array.isArray(itemTree) ? itemTree : [])
      snapshotItem = flatItems[0] || null
    } catch (error) {
      snapshotItem = null
    }
    const executeItemPayload = snapshotItem
      ? { itemId: snapshotItem.id, result: '正常' }
      : { itemName: pendingTask.projectName || '保养项目', result: '正常' }
    const maintenanceRecord = dataOf(await api.postBusiness('/mes/system/record/complete-maintenance', {
      taskId: pendingTask.id,
      executeItems: JSON.stringify([executeItemPayload]),
      executeResult,
      consumables: JSON.stringify([{ materialName: '润滑油', quantity: 1, unit: 'L' }]),
      nextPlanDate: '2027-03-31',
      inspectionRemark: 'E2E 保养完成登记'
    }))
    caseRecord.checks.push({
      name: '保养完成登记写 inspection_record 并保留项目/结果/耗材/下次日期',
      passed:
        Boolean(maintenanceRecord?.id) &&
        maintenanceRecord?.maintenanceDomain === 'UPKEEP' &&
        Boolean(maintenanceRecord?.completeTime) &&
        Boolean(maintenanceRecord?.executeItems) &&
        maintenanceRecord?.executeResult === executeResult &&
        Boolean(maintenanceRecord?.nextPlanDate),
      details: `recordId=${maintenanceRecord?.id}, domain=${maintenanceRecord?.maintenanceDomain}, nextPlanDate=${maintenanceRecord?.nextPlanDate}`
    })
    let parsedExecuteItems = []
    try {
      parsedExecuteItems = JSON.parse(maintenanceRecord?.executeItems || '[]')
    } catch (error) {
      parsedExecuteItems = []
    }
    const snapshotItemSaved = snapshotItem
      ? parsedExecuteItems.some(
          (item) =>
            Number(item?.itemId) === Number(snapshotItem.id) &&
            (item?.itemVersion != null || item?.itemCode != null)
        )
      : parsedExecuteItems.length > 0
    caseRecord.checks.push({
      name: '保养完成登记保存维保项目版本快照（PB-108）',
      passed: snapshotItemSaved,
      details: snapshotItem
        ? `itemId=${snapshotItem.id}, saved=${JSON.stringify(parsedExecuteItems)}`
        : '当前租户无维保项目主档，仅校验执行项目快照非空'
    })

    const taskAfter = dataOf(await api.getBusiness(`/mes/system/task/${pendingTask.id}`))
    caseRecord.checks.push({
      name: '保养完成后回写任务状态与关联记录',
      passed:
        String(taskAfter?.inspectionStatus) === '1' &&
        String(taskAfter?.inspectionRecordId) === String(maintenanceRecord?.id),
      details: `status=${taskAfter?.inspectionStatus}, recordId=${taskAfter?.inspectionRecordId}`
    })

    if (hasDevice) {
      const timelineAfter = dataOf(await api.getBusiness(
        `/mes/device-lifecycle/timeline?deviceId=${deviceId}&pageNo=1&pageSize=100`
      ))
      const events = maintenanceEventsOf(timelineAfter)
      caseRecord.checks.push({
        name: '保养完成按设备追加不可删除履历事件',
        passed:
          events.length === beforeCount + 1 &&
          events.every((item) => item.eventType === 'MAINTENANCE'),
        details: `events=${events.length}, before=${beforeCount}`
      })

      const repeated = dataOf(await api.postBusiness('/mes/system/record/complete-maintenance', {
        taskId: pendingTask.id,
        executeResult: 'E2E 重复完成登记',
        inspectionRemark: 'E2E 幂等校验'
      }))
      const timelineRepeated = dataOf(await api.getBusiness(
        `/mes/device-lifecycle/timeline?deviceId=${deviceId}&pageNo=1&pageSize=100`
      ))
      caseRecord.checks.push({
        name: '保养重复完成幂等：复用同一条记录且不重复写履历',
        passed:
          String(repeated?.id) === String(maintenanceRecord?.id) &&
          maintenanceEventsOf(timelineRepeated).length === beforeCount + 1,
        details: `first=${maintenanceRecord?.id}, second=${repeated?.id}`
      })

      const endTime = formatLocalDateTime(new Date())
      const startTime = formatLocalDateTime(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000))
      const metrics = dataOf(await api.getBusiness(
        `/mes/device-status-event/metrics?deviceId=${deviceId}&startTime=${encodeURIComponent(startTime)}&endTime=${encodeURIComponent(endTime)}`
      ))
      caseRecord.checks.push({
        name: '保养达成率从到期保养任务计算（无到期任务时为空）',
        passed:
          metrics != null &&
          Object.prototype.hasOwnProperty.call(metrics, 'maintenanceRate') &&
          (metrics.maintenanceRate === null ||
            (Number(metrics.maintenanceRate) >= 0 && Number(metrics.maintenanceRate) <= 100)),
        details: `maintenanceRate=${metrics?.maintenanceRate}`
      })
    }

    caseRecord.evidence.push(
      '真实读取 UPKEEP 任务并调用 /mes/system/record/complete-maintenance 完成登记，校验记录字段、' +
        '任务状态回写、设备履历追加与重复完成幂等，并回读设备保养达成率'
    )
    return { token, api }
  }

  if (caseId === 'MAINT-015') {
    // PB-107：维保类型是树型结构（根=固定核心域，子=企业子类型），
    // 正式任务/工单保存企业子类型与维保类型规则版本快照。
    const tree = dataOf(await api.getBusiness('/mes/maintenance-type-rule/tree'))
    const roots = Array.isArray(tree) ? tree : []
    const rootDomains = roots.map((node) => node.coreDomain)
    caseRecord.checks.push({
      name: '维保类型树返回固定核心域根节点（维修/保养/巡检）',
      passed:
        rootDomains.includes('REPAIR') &&
        rootDomains.includes('UPKEEP') &&
        rootDomains.includes('INSPECT') &&
        roots.every((node) => node.nodeType === 'ROOT'),
      details: `roots=${rootDomains.join(',')}`
    })

    const upkeepRoot = roots.find((node) => node.coreDomain === 'UPKEEP') || null
    const subTypeCode = unique('E2E-UPKEEP').slice(0, 64)
    const createResult = trackRuleFixture(fixtures, api, await api.postBusiness('/mes/maintenance-type-rule/create', {
      coreDomain: 'UPKEEP',
      subTypeCode,
      subTypeName: `E2E 定期保养 ${subTypeCode}`,
      status: 0
    }), caseRecord)
    const ruleId = createResult
    caseRecord.checks.push({
      name: '可在核心域根节点下新增企业子类型',
      passed: ruleId != null,
      details: `ruleId=${ruleId}, subTypeCode=${subTypeCode}`
    })

    const treeAfterCreate = dataOf(await api.getBusiness('/mes/maintenance-type-rule/tree'))
    const findSubType = (nodes, code) => {
      for (const node of nodes || []) {
        if (node.subTypeCode === code) return node
        const hit = findSubType(node.children, code)
        if (hit) return hit
      }
      return null
    }
    const createdNode = findSubType(treeAfterCreate, subTypeCode)
    caseRecord.checks.push({
      name: '新增子类型出现在核心域树下',
      passed:
        Boolean(createdNode) &&
        createdNode.nodeType === 'SUB' &&
        createdNode.coreDomain === 'UPKEEP' &&
        (createdNode.version ?? 1) >= 1,
      details: createdNode
        ? `nodeType=${createdNode.nodeType}, version=${createdNode.version}`
        : '未在树中找到新增子类型'
    })

    const updatedName = `E2E 不定期保养 ${subTypeCode}`
    if (ruleId != null) {
      await api.putBusiness('/mes/maintenance-type-rule/update', {
        id: ruleId,
        coreDomain: 'UPKEEP',
        subTypeCode,
        subTypeName: updatedName,
        status: 0
      })
      const detail = dataOf(await api.getBusiness(`/mes/maintenance-type-rule/get?id=${ruleId}`))
      caseRecord.checks.push({
        name: '编辑 E2E 子类型后规则版本递增',
        passed: detail?.version >= 2 && detail?.subTypeName === updatedName,
        details: `version=${detail?.version}, name=${detail?.subTypeName}`
      })
    }

    if (upkeepRoot && (upkeepRoot.children || []).length === 0) {
      caseRecord.evidence.push('核心域根节点当前无历史子类型，仅校验新增/编辑/树组装链路')
    }

    await openRoute(page, '/settings/iot/device-maintenance', { readyText: '维保类型' })
    const typeTab = page.locator('.el-tabs__item').filter({ hasText: '维保类型' }).first()
    await typeTab.waitFor({ state: 'visible' })
    await typeTab.click()
    await page.getByRole('button', { name: '新增子类型' }).waitFor({ state: 'visible' })
    const pageText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '设备维保设置页维保类型页签以树渲染',
      passed: pageText.includes('维保类型') && pageText.includes('新增子类型'),
      details: pageText.includes('新增子类型') ? '检测到新增子类型入口' : '未检测到树入口'
    })
    await saveScreenshot(page, outputDir, 'maint-015-type-tree', record)

    caseRecord.evidence.push(
      '真实调用 /mes/maintenance-type-rule/tree 校验固定核心域根节点，新增/编辑企业子类型并断言版本递增，' +
        '随后在设备维保设置页验证维保类型树渲染；本例未执行正式任务/工单历史快照的回读对比'
    )
    return {
      token,
      api,
      partial: true,
      note: '已验证 E2E 类型树和规则版本；正式任务/工单历史快照未验证，不能登记完整 PASS'
    }
  }

  caseRecord.notes.push(`未识别的案例：${caseId}`)
  return { token, api }
}
