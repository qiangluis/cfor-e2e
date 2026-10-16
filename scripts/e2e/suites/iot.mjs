import { createApiClient } from '../lib/api.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { config } from '../config/index.mjs'
import { runIotReadonlyCase } from './iot-readonly.mjs'
import { runIotFoundationReadonlyCase } from './iot-foundation-readonly.mjs'
import {
  assertIotLocalTarget,
  assertIotMessageRuntimeEnabled,
  createIotFixtureCleanup,
  finalizeIotCatalogAssertions,
  initializeIotCatalogAssertions,
  runIotSecurityE2e
} from '../fixtures/iot-write-closure.mjs'

export const cases = [
  'IOT-001',
  'IOT-002',
  'IOT-003',
  'IOT-007',
  'IOT-008',
  'IOT-009',
  'IOT-010',
  'IOT-011',
  'IOT-012',
  'IOT-013'
]

export const IOT_011_ROUTE = '/iot/device/write-back-dead-letter'
export const IOT_012_ROUTE = '/iot/device/device-change-audit'

const dataOf = (response) => {
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

export const containsE2eMarker = (value) => /(?:^|[^a-z0-9])E2E(?:[^a-z0-9]|$)/i.test(
  [value?.idempotentKey, value?.messageId, value?.identifier]
    .filter((item) => typeof item === 'string').join(' ')
)

export const nicknameBeforeChange = (device) => device?.nickname ?? null

export const createDomContentLoadedPage = (page) => new Proxy(page, {
  get (target, property, receiver) {
    if (property === 'waitForURL') {
      return (urlOrPredicate, options = {}) => target.waitForURL(
        urlOrPredicate,
        { ...options, waitUntil: 'domcontentloaded' }
      )
    }
    const value = Reflect.get(target, property, receiver)
    return typeof value === 'function' ? value.bind(target) : value
  }
})

const runFoundationReadonlyCase = async (
  { caseId, page, record, caseRecord, outputDir },
  dependencies
) => runIotFoundationReadonlyCase({
  caseId,
  page: createDomContentLoadedPage(page),
  record,
  caseRecord,
  outputDir
}, dependencies)

export const runCase = async (
  { caseId, page, record, caseRecord, outputDir },
  dependencies = {}
) => {
  caseRecord.notes.push('案例已锁定 iot_device 唯一设备档案事实源，旧 MES 设备档案只允许兼容读取。')
  caseRecord.notes.push(
    '设备产能复用 APS 工艺路线工序设备产能并增加版本与发布状态，设备三层状态不得由字典页面直接改运行事实。'
  )

  if (caseId === 'IOT-001') {
    const helpers = {
      login,
      createApiClient,
      openRoute,
      saveScreenshot,
      ...dependencies
    }
    return await runFoundationReadonlyCase(
      { caseId, page, record, caseRecord, outputDir },
      helpers
    )
  }
  if (caseId === 'IOT-002') {
    return await runIotWriteCase(
      { caseId, page, record, caseRecord, outputDir },
      dependencies
    )
  }
  if (caseId === 'IOT-003') {
    return await runIotReadonlyCase({ caseId, page, record, caseRecord, outputDir })
  }
  if (caseId === 'IOT-007') {
    return await runDeviceDeptCase({ page, record, caseRecord, outputDir })
  }
  if (caseId === 'IOT-008') {
    return await runPointVersionCase({ page, record, caseRecord, outputDir })
  }
  if (caseId === 'IOT-009') {
    return await runIotWriteCase(
      { caseId, page, record, caseRecord, outputDir },
      dependencies
    )
  }
  if (caseId === 'IOT-010') {
    return await runIotWriteCase(
      { caseId, page, record, caseRecord, outputDir },
      dependencies
    )
  }
  if (caseId === 'IOT-011') {
    return await runIotWriteCase(
      { caseId, page, record, caseRecord, outputDir },
      dependencies
    )
  }
  if (caseId === 'IOT-012') {
    return await runDeviceChangeAuditCase({ page, record, caseRecord, outputDir })
  }
  if (caseId === 'IOT-013') {
    return await runIotWriteCase(
      { caseId, page, record, caseRecord, outputDir },
      dependencies
    )
  }
  return { designed: true }
}

const runIotWriteCase = async (
  { caseId, page, record, caseRecord, outputDir },
  dependencies
) => {
  const helpers = {
    login,
    createApiClient,
    openRoute,
    saveScreenshot,
    runIotSecurityE2e,
    ...dependencies
  }
  const runtime = dependencies.runtime || config
  assertIotLocalTarget(runtime, { requireTenantId: false })
  assertIotMessageRuntimeEnabled(runtime, caseId)
  const auth = await helpers.login(page, { returnContext: true })
  const token = auth?.token
  const tenantId = auth?.tenantId
  if (!token || tenantId == null) {
    throw new Error('BLOCKED: IoT 写侧登录缺少可验证的 token/tenantId 上下文')
  }
  assertIotLocalTarget({ ...runtime, tenantId })
  const api = helpers.createApiClient({ token, tenantId, record })
  const fixtures = createIotFixtureCleanup({ caseId, caseRecord })
  initializeIotCatalogAssertions(caseRecord, caseId)
  let executionFailed = true
  let result
  try {
    result = await helpers.runIotSecurityE2e({
      caseId,
      api,
      fixtures,
      caseRecord,
      page,
      outputDir,
      record,
      openRoute: helpers.openRoute,
      saveScreenshot: helpers.saveScreenshot
    })
    executionFailed = caseRecord.checks.some((check) => check.passed === false)
  } finally {
    await fixtures.cleanup(executionFailed)
  }
  const conclusion = finalizeIotCatalogAssertions(caseRecord)
  return {
    token,
    api,
    ...result,
    ...conclusion,
    partial: result?.partial === true || conclusion.partial,
    acceptanceComplete: conclusion.acceptanceComplete === true
  }
}

/** PB-320：设备台账关键字段变更审计与审批。 */
const runDeviceChangeAuditCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })
  caseRecord.checks.push({
    name: '真实登录成功',
    passed: Boolean(token),
    details: '登录后使用真实令牌校验设备台账变更审计与审批接口'
  })

  const auditPage = dataOf(await api.getBusiness('/iot/device-change-audit/page?pageNo=1&pageSize=10'))
  caseRecord.checks.push({
    name: '设备变更审计分页接口可用',
    passed: Array.isArray(auditPage?.list),
    details: `total=${auditPage?.total ?? 0}`
  })

  const products = dataOf(await api.getBusiness('/iot/product/simple-list')) || []
  const product = products.find((item) => item?.id != null)
  if (!product) {
    caseRecord.notes.push(
      '当前租户无可用 IoT 产品，未创建 E2E 设备夹具；不修改用户设备。'
    )
  } else {
    let deviceId
    try {
      const deviceName = `E2E-IOT-012-${Date.now().toString(36).toUpperCase()}`
      deviceId = dataOf(await api.postBusiness('/iot/device/create', {
        productId: product.id,
        deviceName
      }))
      const device = dataOf(await api.getBusiness(`/iot/device/get?id=${deviceId}`))
      const originalNickname = nicknameBeforeChange(device)
      const tempNickname = `${originalNickname || deviceName}-e2e`
      // Only mutate the device created by this case.
      await api.putBusiness('/iot/device/update', {
        ...device,
        nickname: tempNickname,
        changeReason: 'E2E 关键字段变更',
        changeApprovalRequired: true
      })
      const pendingPage = dataOf(
        await api.getBusiness(
          `/iot/device-change-audit/page?pageNo=1&pageSize=10&deviceId=${device.id}&approvalStatus=PENDING`
        )
      )
      const pending = (pendingPage?.list || []).find(
        (item) => String(item.deviceId) === String(deviceId) && item.reason === 'E2E 关键字段变更'
      )
      caseRecord.checks.push({
        name: '关键字段变更生成待审批审计并保留前后值',
        passed:
          Boolean(pending) &&
          (pending.fieldChanges || []).some((item) => item.field === 'nickname') &&
          pending.reason === 'E2E 关键字段变更',
        details: pending
          ? `auditId=${pending.id}, fields=${(pending.fieldChanges || []).map((item) => item.field).join(',')}`
          : '未生成 E2E 待审批审计记录'
      })
      const afterSubmit = dataOf(await api.getBusiness(`/iot/device/get?id=${device.id}`))
      caseRecord.checks.push({
        name: '要求审批时设备主数据保持不变',
        passed: afterSubmit?.nickname === originalNickname,
        details: `nickname=${afterSubmit?.nickname}`
      })
      if (pending?.id) {
        await api.putBusiness('/iot/device-change-audit/approve', { id: pending.id, opinion: 'E2E 通过' })
        const afterApprove = dataOf(await api.getBusiness(`/iot/device/get?id=${device.id}`))
        caseRecord.checks.push({
          name: '审批通过后应用关键字段变更',
          passed: afterApprove?.nickname === tempNickname,
          details: `nickname=${afterApprove?.nickname}`
        })
      }
    } finally {
      if (deviceId) {
        await api.deleteBusiness(`/iot/device/delete?id=${encodeURIComponent(deviceId)}`).then(async () => {
          const remaining = await api.getBusiness(`/iot/device/get?id=${encodeURIComponent(deviceId)}`)
          caseRecord.checks.push({
            name: 'IOT-012 E2E 设备夹具已删除',
            passed: remaining?.data === null,
            details: `deviceId=${deviceId}`
          })
        }).catch((error) => {
          caseRecord.checks.push({
            name: 'IOT-012 E2E 设备夹具已删除',
            passed: false,
            details: `deviceId=${deviceId}: ${error.message}`
          })
          caseRecord.notes.push(`IOT-012 E2E 设备夹具清理失败 deviceId=${deviceId}: ${error.message}`)
        })
      }
    }
    caseRecord.notes.push('IOT-012 仅创建并清理本案例 E2E 设备夹具，不修改用户设备。')
  }

  await openRoute(page, IOT_012_ROUTE, { readyText: '变更字段' })
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '设备变更审计页面渲染',
    passed: bodyText.includes('设备变更审计') && bodyText.includes('变更字段'),
    details: `真实打开 ${IOT_012_ROUTE} 并校验页面标题与变更字段列`
  })
  await saveScreenshot(page, outputDir, 'pb320-device-change-audit', record)
  caseRecord.evidence.push(
    'PB-320：设备台账关键字段变更保留字段前后值与原因，可走审批后再生效；主数据仍以 iot_device 为唯一事实源。'
  )
  return {
    token,
    partial: !product,
    note: product ? '' : '缺少产品，未验证 E2E 设备变更审批链，不能将页面与空集登记为完整 PASS'
  }
}

/** PB-331：回写/采集失败进入重试死信队列，未知设备不静默丢弃。 */
const runWriteBackDeadLetterCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })
  caseRecord.checks.push({
    name: '真实登录成功',
    passed: Boolean(token),
    details: '登录后使用真实令牌校验回写死信队列接口'
  })

  const pageData = dataOf(
    await api.getBusiness('/iot/write-back-dead-letter/page?pageNo=1&pageSize=10')
  )
  caseRecord.checks.push({
    name: '回写死信分页接口可用',
    passed: Array.isArray(pageData?.list),
    details: `total=${pageData?.total ?? 0}`
  })

  const pending = (pageData?.list || []).find(
    (item) => item.status !== 'HANDLED' && containsE2eMarker(item)
  )
  if (pending) {
    await api.putBusiness('/iot/write-back-dead-letter/handle', {
      id: pending.id,
      handleRemark: 'E2E 自动人工接管'
    })
    const afterHandle = dataOf(await api.getBusiness(`/iot/write-back-dead-letter/get?id=${pending.id}`))
    caseRecord.checks.push({
      name: '死信可人工接管',
      passed: afterHandle?.status === 'HANDLED',
      details: `id=${pending.id}, status=${afterHandle?.status}`
    })
  } else {
    caseRecord.notes.push(
      pageData?.total
        ? '当前租户存在非 E2E 未处理回写死信，本例不接管共享数据；需专属 E2E 死信夹具后复测人工接管。'
        : '当前租户暂无回写死信；本例仅完成接口与页面复测，不将空集升级为完整 PASS。'
    )
  }

  await openRoute(page, IOT_011_ROUTE, { readyText: '最近失败原因' })
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '回写死信页面渲染',
    passed: bodyText.includes('回写死信队列') && bodyText.includes('最近失败原因'),
    details: `真实打开 ${IOT_011_ROUTE} 并校验页面标题与最近失败原因列`
  })
  await saveScreenshot(page, outputDir, 'pb331-iot-write-back-dead-letter', record)
  caseRecord.evidence.push(
    'PB-331：数据流转投递失败与未知设备上行消息统一进入 iot_write_back_dead_letter，按幂等键去重并支持人工接管。'
  )
  return {
    token,
    partial: !pending,
    note: pending
      ? ''
      : '没有可安全接管的 E2E 回写死信夹具，页面/空集证据不构成完整 PASS'
  }
}

/** PB-330：告警持续时间/抑制/升级配置与确认/转工单/解除/关闭闭环。 */
const runAlertLifecycleCase = async (context) =>
  runIotReadonlyCase({ ...context, caseId: 'IOT-010' })

/** PB-329：采集重复/乱序/质量码异常进入数据异常队列，禁止静默丢弃。 */
const runDataAnomalyCase = async (context) =>
  runIotReadonlyCase({ ...context, caseId: 'IOT-009' })

/** PB-327：设备按 system_dept 归属并支持部门数据范围过滤。 */
const runDeviceDeptCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })
  caseRecord.checks.push({
    name: '真实登录成功',
    passed: Boolean(token),
    details: '登录后使用真实令牌校验设备部门归属和数据权限过滤参数'
  })

  const depts = dataOf(await api.getBusiness('/system/dept/simple-list')) || []
  const dept = depts.find((item) => item.id != null)
  if (!dept) {
    caseRecord.notes.push('当前租户没有可用于设备归属的启用部门，未创建设备夹具。')
    return { token, api, partial: true, note: '缺少启用部门前置' }
  }

  const products = dataOf(await api.getBusiness('/iot/product/simple-list')) || []
  const product = products.find((item) => item.id != null)
  if (!product) {
    caseRecord.notes.push('当前租户没有可用于创建设备的 IoT 产品，未创建设备夹具。')
    return { token, api, partial: true, note: '缺少 IoT 产品前置' }
  }

  let deviceId
  try {
    const deviceName = `E2E-PB327-${Date.now().toString(36).toUpperCase()}`
    deviceId = dataOf(
      await api.postBusiness('/iot/device/create', {
        productId: product.id,
        deviceName,
        deptId: dept.id,
        productionLineId: ''
      })
    )
    const device = dataOf(await api.getBusiness(`/iot/device/get?id=${deviceId}`))
    caseRecord.checks.push({
      name: '设备创建后按 system_dept 回读所属部门',
      passed: String(device?.deptId) === String(dept.id),
      details: `deviceId=${deviceId}, deptId=${device?.deptId}, deptName=${dept.name}`
    })

    const pageData = dataOf(
      await api.getBusiness(`/iot/device/page?pageNo=1&pageSize=100&deptId=${dept.id}`)
    )
    const filteredList = pageData?.list || []
    caseRecord.checks.push({
      name: '设备分页按部门参数过滤',
      passed:
        filteredList.some((item) => String(item.id) === String(deviceId)) &&
        filteredList.every((item) => String(item.deptId) === String(dept.id)),
      details: `total=${pageData?.total}, returned=${filteredList.length}, deptId=${dept.id}`
    })

    await openRoute(page, '/iot/device/device', { readyText: '所属部门' })
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '设备页面提供部门筛选和部门展示',
      passed: bodyText.includes('所属部门'),
      details: '设备列表页真实渲染所属部门筛选项和展示字段'
    })
    await saveScreenshot(page, outputDir, 'pb327-iot-device-dept', record)
    caseRecord.evidence.push(
      `复用 system_dept，设备 ${deviceName} 的 deptId=${dept.id}，分页参数和页面字段均已验证`
    )
  } finally {
    if (deviceId) {
      const deleted = await api.deleteBusiness(`/iot/device/delete?id=${deviceId}`)
      assertBusinessSuccess(deleted, `清理 IOT-007 E2E 设备 id=${deviceId}`)
    }
  }

  return { token }
}

/** PB-328：点位版本由服务端维护，协议配置变化递增、仅状态变化不递增。 */
const runPointVersionCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })
  caseRecord.checks.push({
    name: '真实登录成功',
    passed: Boolean(token),
    details: '登录后使用真实令牌校验点位版本递增规则'
  })

  const modbusDevice = await findModbusDevice(api)
  if (!modbusDevice) {
    throw new Error('BLOCKED: 当前租户没有 Modbus 协议设备，无法验证点位版本')
  }
  const thingModels = dataOf(
    await api.getBusiness(`/iot/thing-model/list?productId=${modbusDevice.productId}&type=1`)
  )
  const thingModel = (thingModels || []).find((item) => item.id != null)
  if (!thingModel) {
    throw new Error('BLOCKED: Modbus 设备所属产品没有可用的物模型属性')
  }
  const existingPoints = dataOf(
    await api.getBusiness(
      `/iot/device-modbus-point/page?pageNo=1&pageSize=100&deviceId=${modbusDevice.id}`
    )
  )
  const usedIdentifiers = new Set((existingPoints?.list || []).map((item) => item.identifier))
  if (usedIdentifiers.has(thingModel.identifier)) {
    throw new Error('BLOCKED: 候选物模型属性已被该设备点位占用')
  }

  const maxAddress = (existingPoints?.list || []).reduce(
    (max, item) => Math.max(max, Number(item.registerAddress) || 0),
    0
  )
  let pointId
  try {
    pointId = dataOf(
      await api.postBusiness('/iot/device-modbus-point/create', {
        deviceId: modbusDevice.id,
        thingModelId: thingModel.id,
        functionCode: 3,
        registerAddress: maxAddress + 10,
        registerCount: 1,
        byteOrder: 'AB',
        rawDataType: 'INT16',
        scale: 1,
        pollInterval: 5000,
        status: 0
      })
    )
    const created = dataOf(await api.getBusiness(`/iot/device-modbus-point/get?id=${pointId}`))
    caseRecord.checks.push({
      name: '新建点位版本初始化为 1',
      passed: Number(created?.pointVersion) === 1,
      details: `pointId=${pointId}, pointVersion=${created?.pointVersion}`
    })

    await api.putBusiness('/iot/device-modbus-point/update', {
      id: pointId,
      deviceId: modbusDevice.id,
      thingModelId: thingModel.id,
      functionCode: 3,
      registerAddress: maxAddress + 11,
      registerCount: 1,
      byteOrder: 'AB',
      rawDataType: 'INT16',
      scale: 1,
      pollInterval: 5000,
      status: 0
    })
    const afterProtocolChange = dataOf(
      await api.getBusiness(`/iot/device-modbus-point/get?id=${pointId}`)
    )
    caseRecord.checks.push({
      name: '协议配置变化后点位版本递增',
      passed: Number(afterProtocolChange?.pointVersion) === 2,
      details: `registerAddress=${maxAddress + 11}, pointVersion=${afterProtocolChange?.pointVersion}`
    })

    await api.putBusiness('/iot/device-modbus-point/update', {
      id: pointId,
      deviceId: modbusDevice.id,
      thingModelId: thingModel.id,
      functionCode: 3,
      registerAddress: maxAddress + 11,
      registerCount: 1,
      byteOrder: 'AB',
      rawDataType: 'INT16',
      scale: 1,
      pollInterval: 5000,
      status: 1
    })
    const afterStatusChange = dataOf(
      await api.getBusiness(`/iot/device-modbus-point/get?id=${pointId}`)
    )
    caseRecord.checks.push({
      name: '仅状态变化不递增点位版本',
      passed: Number(afterStatusChange?.pointVersion) === 2,
      details: `status=${afterStatusChange?.status}, pointVersion=${afterStatusChange?.pointVersion}`
    })

    await openRoute(page, `/iot/device/detail?id=${modbusDevice.id}`)
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '点位列表展示点位版本',
      passed: bodyText.includes('点位版本'),
      details: 'Modbus 点位列表真实渲染点位版本列'
    })
    await saveScreenshot(page, outputDir, 'pb328-iot-point-version', record)
    caseRecord.evidence.push(
      `点位版本以 iot_device_modbus_point.point_version 为唯一事实源，pointId=${pointId} 由 v1 递增到 v2，状态开关不递增`
    )
  } finally {
    if (pointId) {
      await api.delete(`/iot/device-modbus-point/delete?id=${pointId}`).catch(() => {})
    }
  }

  return { token }
}

/** 查找一台 Modbus 协议设备，找不到时返回 null。 */
const findModbusDevice = async (api) => {
  const pageData = dataOf(await api.getBusiness('/iot/device/page?pageNo=1&pageSize=100'))
  for (const device of pageData?.list || []) {
    if (device.id == null || device.productId == null) {
      continue
    }
    const product = dataOf(await api.getBusiness(`/iot/product/get?id=${device.productId}`))
    const protocolType = String(product?.protocolType || '')
    if (protocolType.includes('modbus')) {
      return { id: device.id, productId: device.productId, protocolType }
    }
  }
  return null
}
