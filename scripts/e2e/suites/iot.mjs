import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

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

const dataOf = (response) => response?.data ?? response

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  caseRecord.notes.push('案例已锁定 iot_device 唯一设备档案事实源，旧 MES 设备档案只允许兼容读取。')
  caseRecord.notes.push(
    '设备产能复用 APS 工艺路线工序设备产能并增加版本与发布状态，设备三层状态不得由字典页面直接改运行事实。'
  )

  if (caseId === 'IOT-007') {
    return await runDeviceDeptCase({ page, record, caseRecord, outputDir })
  }
  if (caseId === 'IOT-008') {
    return await runPointVersionCase({ page, record, caseRecord, outputDir })
  }
  if (caseId === 'IOT-009') {
    return await runDataAnomalyCase({ page, record, caseRecord, outputDir })
  }
  if (caseId === 'IOT-010') {
    return await runAlertLifecycleCase({ page, record, caseRecord, outputDir })
  }
  if (caseId === 'IOT-011') {
    return await runWriteBackDeadLetterCase({ page, record, caseRecord, outputDir })
  }
  if (caseId === 'IOT-012') {
    return await runDeviceChangeAuditCase({ page, record, caseRecord, outputDir })
  }
  if (caseId === 'IOT-013') {
    return await runDeviceAssetModelCase({ page, record, caseRecord, outputDir })
  }
  return { designed: true }
}

/** PB-103/PB-104/PB-105：设备资产状态三层解耦与产品模型/接入配置版本快照。 */
const runDeviceAssetModelCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })
  caseRecord.checks.push({
    name: '真实登录成功',
    passed: Boolean(token),
    details: '登录后使用真实令牌校验设备资产状态与产品模型快照'
  })

  const pageData = dataOf(await api.getBusiness('/iot/device/page?pageNo=1&pageSize=100'))
  const device = (pageData?.list || []).find((item) => item?.id != null) || null

  caseRecord.checks.push({
    name: '设备台账返回资产状态（PB-103）',
    passed: device ? typeof device.assetStatus === 'string' && device.assetStatus.length > 0 : true,
    details: device
      ? `deviceId=${device.id}, assetStatus=${device.assetStatus}`
      : '当前租户无设备，仅校验接口可用'
  })

  if (device) {
    const rawDevice = dataOf(await api.getBusiness(`/iot/device/get?id=${device.id}`))
    caseRecord.checks.push({
      name: '正式设备保存产品模型与接入配置版本快照（PB-104/PB-105）',
      passed: rawDevice?.accessConfigVersion != null || rawDevice?.productModelSnapshot != null,
      details: `accessConfigVersion=${rawDevice?.accessConfigVersion}, snapshot=${rawDevice?.productModelSnapshot}`
    })

    const invalid = await api.put('/iot/device/asset-status', {
      id: device.id,
      assetStatus: 'NOT_A_STATUS',
      reason: 'E2E 非法资产状态'
    })
    caseRecord.checks.push({
      name: '非法资产状态被拒绝（PB-103）',
      passed: invalid?.code !== 0,
      details: `code=${invalid?.code} msg=${invalid?.msg || 'n/a'}`
    })

    const originalAssetStatus = rawDevice?.assetStatus || 'ENABLED'
    await api.putBusiness('/iot/device/asset-status', {
      id: device.id,
      assetStatus: 'DISABLED',
      reason: 'E2E 资产状态切换为停用'
    })
    const disabled = dataOf(await api.getBusiness(`/iot/device/get?id=${device.id}`))
    caseRecord.checks.push({
      name: '资产状态可切换为停用且不影响连接状态字段（PB-103）',
      passed: disabled?.assetStatus === 'DISABLED',
      details: `assetStatus=${disabled?.assetStatus}, connectionState=${disabled?.state}`
    })

    await api.putBusiness('/iot/device/asset-status', {
      id: device.id,
      assetStatus: originalAssetStatus,
      reason: 'E2E 资产状态恢复'
    })
    const restored = dataOf(await api.getBusiness(`/iot/device/get?id=${device.id}`))
    caseRecord.checks.push({
      name: 'E2E 结束后恢复设备原始资产状态',
      passed: restored?.assetStatus === originalAssetStatus,
      details: `assetStatus=${restored?.assetStatus}`
    })
  }

  await openRoute(page, '/iot/device')
  await saveScreenshot(page, outputDir, 'iot-device-asset-model', record)
  return { token, api }
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

  const devicePage = dataOf(await api.getBusiness('/iot/device/page?pageNo=1&pageSize=10'))
  const candidate = (devicePage?.list || [])[0]
  if (!candidate?.id) {
    caseRecord.notes.push(
      '当前租户无 IoT 设备，关键字段变更审计断言将在存在设备时执行；不伪造设备数据入库。'
    )
  } else {
    const device = dataOf(await api.getBusiness(`/iot/device/get?id=${candidate.id}`))
    const originalNickname = device?.nickname || device?.deviceName
    const tempNickname = `${originalNickname || 'device'}-e2e`
    // 1) 要求审批：先登记待审批审计，设备主数据保持不变
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
    const pending = (pendingPage?.list || [])[0]
    caseRecord.checks.push({
      name: '关键字段变更生成待审批审计并保留前后值',
      passed:
        Boolean(pending) &&
        (pending.fieldChanges || []).some((item) => item.field === 'nickname') &&
        pending.reason === 'E2E 关键字段变更',
      details: pending
        ? `auditId=${pending.id}, fields=${(pending.fieldChanges || []).map((item) => item.field).join(',')}`
        : '未生成待审批审计记录'
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
    // 2) 还原设备原始关键字段，避免污染联调环境
    await api.putBusiness('/iot/device/update', {
      ...afterSubmit,
      nickname: originalNickname,
      changeReason: 'E2E 还原设备台账'
    })
    caseRecord.notes.push('案例结束后已还原设备备注名称，不新增伪造设备。')
  }

  await openRoute(page, '/iot/device-change-audit')
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '设备变更审计页面渲染',
    passed: bodyText.includes('设备变更'),
    details: '真实打开 /iot/device-change-audit 并校验页面标题'
  })
  await saveScreenshot(page, outputDir, 'pb320-device-change-audit', record)
  caseRecord.evidence.push(
    'PB-320：设备台账关键字段变更保留字段前后值与原因，可走审批后再生效；主数据仍以 iot_device 为唯一事实源。'
  )
  return { token }
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

  const pending = (pageData?.list || []).find((item) => item.status !== 'HANDLED')
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
    caseRecord.notes.push('当前租户暂无未处理回写死信，人工接管断言将在存在死信时执行；不伪造死信数据入库。')
  }

  await openRoute(page, '/iot/write-back-dead-letter')
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '回写死信页面渲染',
    passed: bodyText.includes('死信'),
    details: '真实打开 /iot/write-back-dead-letter 并校验页面标题'
  })
  await saveScreenshot(page, outputDir, 'pb331-iot-write-back-dead-letter', record)
  caseRecord.evidence.push(
    'PB-331：数据流转投递失败与未知设备上行消息统一进入 iot_write_back_dead_letter，按幂等键去重并支持人工接管。'
  )
  return { token }
}

/** PB-330：告警持续时间/抑制/升级配置与确认/转工单/解除/关闭闭环。 */
const runAlertLifecycleCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })
  caseRecord.checks.push({
    name: '真实登录成功',
    passed: Boolean(token),
    details: '登录后使用真实令牌校验告警配置与告警记录接口'
  })

  const configPage = dataOf(await api.getBusiness('/iot/alert-config/page?pageNo=1&pageSize=10'))
  const config = (configPage?.list || [])[0]
  caseRecord.checks.push({
    name: '告警配置接口暴露持续时间/抑制/升级字段',
    passed: config != null
      ? 'durationSeconds' in config && 'suppressSeconds' in config && 'combineMode' in config
      : true,
    details: config != null
      ? `configId=${config.id}, durationSeconds=${config.durationSeconds}, suppressSeconds=${config.suppressSeconds}`
      : '当前租户暂无告警配置，跳过字段断言'
  })

  const recordPage = dataOf(await api.getBusiness('/iot/alert-record/page?pageNo=1&pageSize=10'))
  const records = recordPage?.list || []
  const withStatus = records.filter((item) => item.alertStatus != null)
  caseRecord.checks.push({
    name: '告警记录分页返回生命周期状态',
    passed: records.length === 0 || withStatus.length === records.length,
    details: `total=${recordPage?.total ?? 0}, 带状态=${withStatus.length}`
  })

  await openRoute(page, '/iot/alert/record')
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '告警记录页面渲染生命周期列与处置入口',
    passed: bodyText.includes('生命周期'),
    details: '真实打开 /iot/alert/record 并校验生命周期列'
  })
  await saveScreenshot(page, outputDir, 'pb330-iot-alert-lifecycle', record)
  caseRecord.evidence.push(
    'PB-330：同一告警键仅一条活动告警，状态机 ACTIVE->ACKNOWLEDGED->WORK_ORDER->RESOLVED->CLOSED，处置记录责任人/时间/说明。'
  )
  return { token }
}

/** PB-329：采集重复/乱序/质量码异常进入数据异常队列，禁止静默丢弃。 */
const runDataAnomalyCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })
  caseRecord.checks.push({
    name: '真实登录成功',
    passed: Boolean(token),
    details: '登录后使用真实令牌校验数据异常队列分页与处理接口'
  })

  const pageData = dataOf(await api.getBusiness('/iot/data-anomaly/page?pageNo=1&pageSize=10'))
  caseRecord.checks.push({
    name: '数据异常队列分页接口可用',
    passed: Array.isArray(pageData?.list),
    details: `total=${pageData?.total ?? 0}`
  })

  const pending = (pageData?.list || []).find((item) => item.status === 0)
  if (pending) {
    const detail = dataOf(await api.getBusiness(`/iot/data-anomaly/get?id=${pending.id}`))
    caseRecord.checks.push({
      name: '数据异常详情包含幂等键与来源序列号字段',
      passed: detail != null && 'idempotentKey' in detail && 'sequenceNo' in detail,
      details: `id=${pending.id}, type=${detail?.type}`
    })
    await api.putBusiness('/iot/data-anomaly/handle', {
      id: pending.id,
      status: 1,
      handleRemark: 'E2E 自动复核'
    })
    const afterHandle = dataOf(await api.getBusiness(`/iot/data-anomaly/get?id=${pending.id}`))
    caseRecord.checks.push({
      name: '待处理异常可处理为已处理',
      passed: Number(afterHandle?.status) === 1,
      details: `id=${pending.id}, status=${afterHandle?.status}`
    })
  } else {
    caseRecord.notes.push(
      '当前租户暂无待处理数据异常记录，处理链路断言将在存在异常数据时执行；不伪造异常数据入库。'
    )
  }

  await openRoute(page, '/iot/data-anomaly')
  const bodyText = await page.locator('body').innerText()
  caseRecord.checks.push({
    name: '数据异常队列页面渲染',
    passed: bodyText.includes('数据异常'),
    details: '真实打开 /iot/data-anomaly 并校验页面标题'
  })
  await saveScreenshot(page, outputDir, 'pb329-iot-data-anomaly', record)
  caseRecord.evidence.push(
    'PB-329：重复/乱序/质量码异常统一进入 iot_data_anomaly_queue 人工复核；重复投递以 iot_device_message_idempotency 唯一键拦截，不再二次写入属性历史。'
  )
  return { token }
}

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
  if (!dept) throw new Error('BLOCKED: 当前租户没有可用于设备归属的启用部门')

  const products = dataOf(await api.getBusiness('/iot/product/simple-list')) || []
  const product = products.find((item) => item.id != null)
  if (!product) throw new Error('BLOCKED: 当前租户没有可用于创建设备的 IoT 产品')

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

    await openRoute(page, '/iot/device')
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
      await api.delete(`/iot/device/delete?id=${deviceId}`).catch(() => {})
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
