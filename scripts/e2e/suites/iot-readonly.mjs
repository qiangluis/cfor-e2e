import { createApiClient } from '../lib/api.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { findMenuRouteByComponent, isStableId } from './base-partner.mjs'

export const iotReadonlyViews = Object.freeze({
  'IOT-002': {
    component: 'iot/alert/record/index',
    headers: ['记录编号', '告警名称', '点位标识', '生命周期'],
    readySelector: '.el-table__header-wrapper th:has-text("生命周期")'
  },
  'IOT-003': {
    component: 'iot/device/device/index',
    readySelector: '.el-form-item:has-text("设备名称")',
    labels: ['设备名称', '产品', '所属部门']
  },
  'IOT-009': {
    component: 'iot/anomaly/index',
    headers: ['异常类型', '设备编号', '来源序列号', '质量码', '处理状态'],
    readySelector: '.el-table__header-wrapper th:has-text("异常类型")'
  },
  'IOT-010': {
    component: 'iot/alert/record/index',
    headers: ['记录编号', '告警名称', '点位标识', '生命周期'],
    readySelector: '.el-table__header-wrapper th:has-text("生命周期")'
  },
  'IOT-013': {
    component: 'iot/device/device/index',
    readySelector: '.el-form-item:has-text("设备名称")',
    labels: ['设备名称', '产品', '所属部门']
  }
})

const fact = (record, name, passed, details = '') => {
  record.checks.push({ name, passed: Boolean(passed), details })
  if (!passed) throw new Error(`${name}：${details}`)
}
const missing = (record, details) =>
  record.notes.push(`前置缺失：${details}；不以空集或缺少事实的字段断言登记 PASS`)
const object = (value) => value != null && typeof value === 'object' && !Array.isArray(value)
const text = (value) => typeof value === 'string' && value.trim().length > 0
const messageId = (value) => text(value)
const data = (payload, label) => assertBusinessSuccess(payload, label).data
const positiveVersion = (value) => Number.isSafeInteger(value) && value > 0
const listData = (value) => Array.isArray(value?.list) ? value.list : value?.records
const totalData = (value, list) => {
  if (Object.hasOwn(value || {}, 'total')) return value.total
  if (Object.hasOwn(value || {}, 'totalCount')) return value.totalCount
  return list?.length ?? 0
}

export function iotReadonlyPage(payload, label) {
  const result = data(payload, label)
  const list = listData(result)
  const total = totalData(result, list)
  if (!object(result) || !Array.isArray(list) ||
      !Number.isSafeInteger(total) || total < list.length ||
      list.length > 100 || !list.every(object)) {
    throw new Error(`${label} 必须返回有效 data.list/records/total 分页`)
  }
  return { ...result, list, total }
}

async function pageAt(api, caseRecord, path, label = path) {
  const result = iotReadonlyPage(
    await api.getBusiness(path), label)
  fact(caseRecord, '真实分页返回 list/total', true,
    `${label}, rows=${result.list.length}, total=${result.total}；仅验证首100条`)
  if (!result.list.length) missing(caseRecord, `${label} 没有记录，非空字段及动态链路未验证`)
  return result.list
}

async function pageOf(api, caseRecord, base, query = '') {
  return pageAt(api, caseRecord,
    `${base}/page?pageNo=1&pageSize=100${query}`, base)
}

export function validateDeviceSnapshot(device, caseRecord) {
  if (!text(device.productModelSnapshot) || device.accessConfigVersion == null) {
    missing(caseRecord, `设备 ${device.id} 缺模型快照或接入版本，不能用二者 OR 判通过`)
    return false
  }
  let snapshot
  try {
    snapshot = JSON.parse(device.productModelSnapshot)
  } catch {
    fact(caseRecord, '设备产品模型快照是有效 JSON 对象', false, `deviceId=${device.id}`)
  }
  fact(caseRecord, '设备产品模型快照与产品 ID、设备接入版本一致',
    object(snapshot) && isStableId(snapshot.productId) &&
      String(snapshot.productId) === String(device.productId) &&
      positiveVersion(device.accessConfigVersion) &&
      snapshot.accessConfigVersion === device.accessConfigVersion &&
      ['deviceType', 'netType'].every((key) =>
        Number.isSafeInteger(snapshot[key]) && snapshot[key] >= 0) &&
      ['productKey', 'protocolType', 'serializeType'].every((key) => text(snapshot[key])),
    `deviceId=${device.id}, version=${device.accessConfigVersion}`)
  return true
}

// These GET handlers only query facts. No asset, anomaly or alarm state is changed.
export async function runIotReadonlyContract({ caseId, api, caseRecord }) {
  if (!iotReadonlyViews[caseId]) throw new Error(`非目标 IoT 只读案例：${caseId}`)
  if (caseId === 'IOT-002') {
    const devices = await pageOf(api, caseRecord, '/iot/device')
    const messageRows = []
    for (const device of devices.slice(0, 10)) {
      const rows = await pageAt(
        api,
        caseRecord,
        `/iot/device/message/page?pageNo=1&pageSize=100&deviceId=${encodeURIComponent(device.id)}`,
        `/iot/device/message/page?deviceId=${device.id}`
      )
      messageRows.push(...rows)
      for (const row of rows) {
        fact(caseRecord, '设备消息返回稳定 ID、设备、方法和点位版本字段',
          isStableId(row.id) &&
            String(row.deviceId) === String(device.id) &&
            ['method', 'upstream', 'reply', 'identifier', 'pointVersion']
              .every((key) => Object.hasOwn(row, key)),
          `messageId=${row.id}, deviceId=${row.deviceId}`)
      }
    }
    if (!devices.length) missing(caseRecord, '没有设备，设备消息分页无法按必填 deviceId 查询')
    if (!messageRows.length) missing(caseRecord, '当前设备没有消息记录，重复消息幂等和遥测字段未取得非空事实')

    const latest = data(
      await api.getBusiness('/iot/device/message/latest?limit=20'),
      '最新设备消息'
    )
    fact(caseRecord, '最新设备消息接口返回不超过20条列表',
      Array.isArray(latest) && latest.length <= 20,
      `rows=${Array.isArray(latest) ? latest.length : 'invalid'}`)
    if (!latest.length) missing(caseRecord, '最新设备消息为空，无法验证跨设备最新值排序')
    for (const row of Array.isArray(latest) ? latest : []) {
      fact(caseRecord, '最新设备消息包含设备与消息标识',
        object(row) && messageId(row.id) && isStableId(row.deviceId) &&
          ['identifier', 'pointVersion'].every((key) => Object.hasOwn(row, key)),
        `messageId=${row.id}`)
    }

    const anomalies = await pageOf(api, caseRecord, '/iot/data-anomaly')
    for (const row of anomalies) {
      fact(caseRecord, '异常队列返回稳定 ID、类型及处理状态',
        isStableId(row.id) && text(row.type) && [0, 1, 2].includes(row.status),
        `id=${row.id}, type=${row.type}, status=${row.status}`)
    }
    const configs = await pageOf(api, caseRecord, '/iot/alert-config')
    for (const config of configs) {
      fact(caseRecord, '告警配置返回持续、组合、抑制和升级字段',
        isStableId(config.id) &&
          ['durationSeconds', 'combineMode', 'combineExpression', 'suppressSeconds',
            'escalateSeconds', 'escalateLevel'].every((key) => Object.hasOwn(config, key)),
        `configId=${config.id}`)
    }
    const alerts = await pageOf(api, caseRecord, '/iot/alert-record')
    for (const row of alerts) {
      fact(caseRecord, '告警记录返回稳定 ID 与合法生命周期状态',
        isStableId(row.id) &&
          ['ACTIVE', 'ACKNOWLEDGED', 'WORK_ORDER', 'RESOLVED', 'CLOSED'].includes(row.alertStatus),
        `id=${row.id}, alertStatus=${row.alertStatus}`)
    }
    if (!anomalies.length && !configs.length && !alerts.length) {
      missing(caseRecord, '异常、告警配置和告警记录均为空，动态告警闭环未取得非空事实')
    }
    caseRecord.notes.push(
      '仅执行设备消息、最新消息、异常队列、告警配置和告警记录 GET；未发送重复消息、关闭告警或构造跨租户权限反例'
    )
  } else if (caseId === 'IOT-003') {
    const dictRows = await pageOf(
      api,
      caseRecord,
      '/system/dict-data',
      '&dictType=equipment_type'
    )
    for (const row of dictRows) {
      fact(caseRecord, '设备业务类型来自 equipment_type 字典',
        isStableId(row.id) && text(row.label) && row.dictType === 'equipment_type',
        `dictId=${row.id}, value=${row.value}`)
    }

    const products = await pageOf(api, caseRecord, '/iot/product')
    const devices = await pageOf(api, caseRecord, '/iot/device')
    for (const row of products) {
      fact(caseRecord, '产品接入字段与设备业务类型字段分离',
        isStableId(row.id) && text(row.productKey) &&
          Number.isSafeInteger(row.deviceType) && Object.hasOwn(row, 'protocolType'),
        `productId=${row.id}`)
    }
    for (const row of devices) {
      fact(caseRecord, '设备引用产品且保留独立业务类型',
        isStableId(row.id) && isStableId(row.productId) &&
          Number.isSafeInteger(row.deviceType) && Object.hasOwn(row, 'state'),
        `deviceId=${row.id}, productId=${row.productId}`)
    }
    if (!products.length) missing(caseRecord, '没有产品，未取得产品接入字段与设备类型的关联事实')
    if (!devices.length) missing(caseRecord, '没有设备，未取得设备三层状态的非空关联事实')

    const routes = await pageAt(
      api,
      caseRecord,
      '/mes/wmsTechRoute/list?pageNo=1&pageSize=100',
      '/mes/wmsTechRoute/list'
    )
    let capacitySamples = 0
    for (const route of routes.slice(0, 10)) {
      fact(caseRecord, '工艺路线返回稳定 ID 与版本字段',
        isStableId(route.id) && (text(route.version) || Number.isSafeInteger(route.version)),
        `routeId=${route.id}`)
      const procedures = await pageAt(
        api,
        caseRecord,
        `/mes/wmsTechRoute/listMesWmsTechRouteSubByMainId?parentId=${encodeURIComponent(route.id)}&pageNo=1&pageSize=100`,
        `/mes/wmsTechRoute/listMesWmsTechRouteSubByMainId?parentId=${route.id}`
      )
      if (!procedures.length) {
        missing(caseRecord, `工艺路线 ${route.id} 没有工序，产能绑定未取得非空事实`)
        continue
      }
      for (const procedure of procedures.slice(0, 10)) {
        fact(caseRecord, '工艺路线工序引用稳定工序 ID',
          isStableId(procedure.id) &&
            (isStableId(procedure.procedureId) || object(procedure.procedure)),
          `routeId=${route.id}, procedureId=${procedure.id}`)
        const equipmentId =
          procedure.equipmentId ||
          procedure.deviceId ||
          procedure.procedure?.deviceDOList?.[0]?.id
        if (!equipmentId) {
          missing(caseRecord, `工序 ${procedure.id} 没有设备引用，未请求产能版本`)
          continue
        }
        const capacities = data(await api.getBusiness(
          `/mes/wmsTechRoute/capacity/list?routeSubId=${encodeURIComponent(procedure.id)}&equipmentId=${encodeURIComponent(equipmentId)}`
        ), '工序设备产能版本')
        fact(caseRecord, '工序设备产能版本接口返回列表',
          Array.isArray(capacities), `routeSubId=${procedure.id}, equipmentId=${equipmentId}`)
        if (!capacities.length) {
          missing(caseRecord, `工序 ${procedure.id} 没有产能版本，版本发布与历史快照未取得非空事实`)
          continue
        }
        for (const capacity of capacities) {
          capacitySamples++
          fact(caseRecord, '产能版本绑定适用范围、时长、日历和生效期字段',
            object(capacity) &&
              ['id', 'routeSubId', 'equipmentId', 'unitId', 'standardOutput',
                'standardDuration', 'changeoverMinutes', 'calendarCode',
                'effectiveFrom', 'effectiveTo', 'capacityVersion', 'publishStatus']
                .every((key) => Object.hasOwn(capacity, key)) &&
              [0, 1, 2].includes(capacity.publishStatus),
            `capacityId=${capacity.id}`)
        }
      }
    }
    if (!routes.length) missing(caseRecord, '没有工艺路线，未验证工序引用和产能版本')
    if (!capacitySamples) missing(caseRecord, '没有可抽样的产能版本，发布唯一性与排产快照待专属夹具')
    caseRecord.notes.push(
      '仅执行设备类型字典、产品/设备、工艺路线、工序和产能版本 GET；未保存、发布、停用或删除任何版本'
    )
  } else if (caseId === 'IOT-013') {
    const devices = await pageOf(api, caseRecord, '/iot/device')
    for (const device of devices) {
      fact(caseRecord, '设备 ID、资产状态与连接状态使用各自独立字段',
        isStableId(device.id) &&
          ['ENABLED', 'DISABLED', 'SEALED', 'SCRAPPED'].includes(device.assetStatus) &&
          [0, 1, 2].includes(device.state),
        `deviceId=${device.id}, assetStatus=${device.assetStatus}, state=${device.state}`)
    }
    for (const device of devices.slice(0, 10)) {
      const detail = data(await api.getBusiness(
        `/iot/device/get?id=${encodeURIComponent(device.id)}`), '设备详情')
      fact(caseRecord, '设备详情与分页 ID、产品及三层状态快照一致',
        object(detail) && String(detail.id) === String(device.id) &&
          isStableId(detail.productId) && String(detail.productId) === String(device.productId) &&
          detail.assetStatus === device.assetStatus && detail.state === device.state &&
          detail.accessConfigVersion === device.accessConfigVersion &&
          detail.productModelSnapshot === device.productModelSnapshot,
        `deviceId=${device.id}；仅做瞬时回读，不证明变更时状态互不覆盖`)
      validateDeviceSnapshot(detail, caseRecord)
    }
    caseRecord.notes.push(
      '未改变任何共享设备或产品；资产状态非法/合法变更、CONNECTION/RUNTIME 不变、接入配置版本递增及历史快照待隔离夹具验证')
  } else if (caseId === 'IOT-009') {
    const rows = await pageOf(api, caseRecord, '/iot/data-anomaly')
    for (const row of rows) {
      fact(caseRecord, '异常队列返回稳定 ID、类型及处理状态',
        isStableId(row.id) && text(row.type) && [0, 1, 2].includes(row.status),
        `id=${row.id}, type=${row.type}, status=${row.status}`)
    }
    for (const row of rows.slice(0, 10)) {
      const detail = data(await api.getBusiness(
        `/iot/data-anomaly/get?id=${encodeURIComponent(row.id)}`), '异常详情')
      fact(caseRecord, '异常详情与分页一致并暴露幂等、序列号及质量字段',
        object(detail) && String(detail.id) === String(row.id) &&
          detail.type === row.type && detail.status === row.status &&
          ['idempotentKey', 'sequenceNo', 'qualityCode', 'payload']
            .every((key) => Object.hasOwn(detail, key)),
        `id=${row.id}；不打印采集原文，不证明重复消息已拦截`)
    }
    caseRecord.notes.push(
      '未处理共享异常；重复/乱序/质量码受控投递、属性历史不重复及处理幂等仍待专属消息源与异常夹具')
  } else {
    const configs = await pageOf(api, caseRecord, '/iot/alert-config')
    for (const config of configs) {
      fact(caseRecord, '告警配置返回稳定 ID 与持续、组合、抑制、升级字段',
        isStableId(config.id) &&
          ['durationSeconds', 'combineMode', 'combineExpression', 'suppressSeconds',
            'escalateSeconds', 'escalateLevel'].every((key) => Object.hasOwn(config, key)),
        `configId=${config.id}；字段存在不等于配置已实际生效`)
    }
    const rows = await pageOf(api, caseRecord, '/iot/alert-record')
    for (const row of rows) {
      fact(caseRecord, '告警记录返回稳定 ID 与合法生命周期状态',
        isStableId(row.id) &&
          ['ACTIVE', 'ACKNOWLEDGED', 'WORK_ORDER', 'RESOLVED', 'CLOSED'].includes(row.alertStatus),
        `id=${row.id}, alertStatus=${row.alertStatus}`)
    }
    caseRecord.notes.push(
      '未确认、转工单、解除或关闭告警；唯一活动键、非法流转拒绝、责任人时间说明及抑制升级效果仍未取得动态证据')
  }
  return { partial: true, note: '只读契约已执行，核心动态链路及写侧反例未执行，不能登记完整 PASS' }
}

export async function runIotReadonlyCase(
  { caseId, page, record, caseRecord, outputDir },
  dependencies = {}
) {
  const helpers = { login, createApiClient, openRoute, saveScreenshot, ...dependencies }
  const view = iotReadonlyViews[caseId]
  if (!view) throw new Error(`非目标 IoT 只读案例：${caseId}`)
  const token = await helpers.login(page)
  fact(caseRecord, '真实登录成功', Boolean(token))
  const api = helpers.createApiClient({ token, record })
  const permission = data(await api.getBusiness('/system/auth/get-permission-info'), '权限菜单')
  if (!Array.isArray(permission?.menus)) throw new Error('权限响应 data.menus 必须为数组')
  const route = findMenuRouteByComponent(permission.menus, view.component)
  if (!route) throw new Error(`BLOCKED: 权限菜单无 component=${view.component}`)
  const techniqueRoute = caseId === 'IOT-003'
    ? findMenuRouteByComponent(permission.menus, 'mes/produce/technique/index')
    : null
  if (caseId === 'IOT-003' && !techniqueRoute) {
    throw new Error('BLOCKED: 权限菜单无 component=mes/produce/technique/index')
  }
  const result = await runIotReadonlyContract({ caseId, api, caseRecord })
  await helpers.openRoute(page, route, { readySelector: view.readySelector })
  const labels = view.headers
    ? await page.locator('.el-table__header-wrapper th').allInnerTexts()
    : await page.locator('.el-form-item__label').allInnerTexts()
  fact(caseRecord, '真实权限菜单路由与领域界面已渲染',
    new URL(page.url()).pathname === route.split('?')[0] &&
      (view.headers || view.labels).every((expected) =>
        labels.some((label) => label.trim() === expected)),
    `route=${route}, labels=${labels.map((label) => label.trim()).join(',')}`)
  const screenshot = await helpers.saveScreenshot(page, outputDir, `${caseId}-readonly`, record)
  caseRecord.evidence.push(screenshot)
  if (caseId === 'IOT-003') {
    await helpers.openRoute(page, techniqueRoute, { readySelector: '.technique-route' })
    const bodyText = await page.locator('body').innerText()
    fact(caseRecord, '真实工艺路线领域界面已渲染',
      new URL(page.url()).pathname === techniqueRoute.split('?')[0] &&
        bodyText.includes('工艺路线') && bodyText.includes('工序库'),
      `route=${techniqueRoute}`)
    const routeScreenshot = await helpers.saveScreenshot(
      page, outputDir, `${caseId}-technique-readonly`, record
    )
    caseRecord.evidence.push(routeScreenshot)
  }
  return { token, api, ...result }
}
