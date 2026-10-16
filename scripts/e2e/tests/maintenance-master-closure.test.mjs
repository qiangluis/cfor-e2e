import test from 'node:test'
import assert from 'node:assert/strict'
import { runCase } from '../suites/iot-maintenance.mjs'

const success = (data) => ({ code: 0, data })

async function runMaster ({
  rejection = 400,
  changedRoot = false,
  changedField,
  retainedItem = false,
  deviceAvailable = false,
  runVersionedInspectionTasks,
  captureError = false
} = {}) {
  const roots = ['REPAIR', 'UPKEEP', 'INSPECT'].map((categoryRoot, index) => ({
    id: String(index + 1), categoryRoot, systemRoot: true
  }))
  const gets = new Map()
  const deleted = []
  const deletedPaths = []
  const screenshots = []
  let saved
  let itemStatus = 0
  let itemExists = true
  let plan
  let deviceExists = false
  const caseRecord = { checks: [], notes: [], evidence: [] }
  const itemId = '9007199254740993'
  const deviceId = '9007199254740994'
  const planId = '9007199254740995'
  const assignmentId = '9007199254740996'
  const node = {
    first () { return this },
    filter () { return this },
    waitFor: async () => {},
    scrollIntoViewIfNeeded: async () => {},
    click: async () => {},
    inputValue: async () => '',
    getAttribute: async () => 'true',
    getByRole () { return this },
    innerText: async () => `${saved.itemName} 是否 生成维修工单`,
    locator () { return this }
  }
  const dialog = {
    ...node,
    locator () {
      return {
        filter ({ has }) {
          return {
            ...node,
            locator: () => ({
              inputValue: async () => ({
                项目编码: saved.itemCode, 名称: saved.itemName, 执行要求: saved.execRequirement,
                标准工时: String(saved.standardHours)
              })[has.label]
            })
          }
        }
      }
    }
  }
  const api = {
    async getBusiness (path) {
      if (path.endsWith('/tree')) return success(roots)
      if (path === '/iot/product/simple-list') {
        return success(deviceAvailable ? [{ id: '7001', status: 0 }] : [])
      }
      if (path === '/iot/device/get?id=' + deviceId) {
        return deviceExists ? success({
          id: deviceId, productId: '7001', deviceName: 'E2E-MAINT-002-DEVICE', deviceType: 0, state: 0
        }) : { code: 400, msg: '设备不存在' }
      }
      if (path === `/mes/maintenance-plan/get?id=${planId}`) {
        return success(plan)
      }
      const id = new URL(path, 'http://test').searchParams.get('id')
      if (id === itemId) {
        if (!itemExists) return { code: 400, msg: '维保项目不存在' }
        return success({
          ...saved,
          status: itemStatus,
          ...(changedField ? { [changedField]: null } : {})
        })
      }
      gets.set(id, (gets.get(id) || 0) + 1)
      const root = roots.find((item) => item.id === id)
      assert.ok(root, `unexpected GET ${path}`)
      return success({
        ...root, ...(changedRoot && gets.get(id) > 1 ? { itemName: 'changed' } : {})
      })
    },
    async request (method, path, body, options) {
      if (method === 'GET') {
        assert.equal(path, '/mes/maintenance-item/get?id=9007199254740993')
        return retainedItem ? success(saved) : { code: 400, msg: '维保项目不存在' }
      }
      assert.equal(method, 'DELETE')
      const id = new URL(path, 'http://test').searchParams.get('id')
      deleted.push(id)
      assert.equal(options.expectedBusinessRejection.code, 400)
      return { code: rejection, msg: '维修、保养、巡检为不可删除根分类' }
    },
    async postBusiness (path, body) {
      if (path === '/iot/device/create') {
        assert.equal(body.productId, '7001')
        deviceExists = true
        return success(deviceId)
      }
      if (path === '/mes/maintenance-item/create') {
        saved = {
          ...body, id: itemId, systemRoot: false, version: 1, publishStatus: 0
        }
        return success(saved.id)
      }
      if (path === '/mes/maintenance-plan/create') {
        plan = {
          ...body,
          id: planId,
          status: 'DRAFT',
          currentVersion: 1,
          publishedVersion: null
        }
        return success(plan.id)
      }
      if (path === '/mes/maintenance-plan-assignment/create') {
        return success(assignmentId)
      }
      throw new Error(`unexpected POST ${path}`)
    },
    async deleteBusiness (path) {
      deletedPaths.push(path)
      if (path === `/iot/device/delete?id=${deviceId}`) {
        deviceExists = false
        return success(true)
      }
      if (path === `/mes/maintenance-plan/delete?id=${planId}`) {
        plan = null
        return success(true)
      }
      if (path === `/mes/maintenance-item/delete?id=${itemId}`) {
        itemExists = false
        return success(true)
      }
      if (path === `/mes/maintenance-plan-assignment/delete?id=${assignmentId}`) {
        return success(true)
      }
      throw new Error(`unexpected DELETE ${path}`)
    },
    async putBusiness (path, body) {
      if (path === `/mes/maintenance-plan/publish?id=${planId}`) {
        if (body?.publishFailure) return { code: 400, msg: '发布失败' }
        plan = { ...plan, status: 'PUBLISHED', publishedVersion: 1 }
        return success(true)
      }
      if (path === `/mes/maintenance-plan/disable?id=${planId}`) {
        plan = { ...plan, status: 'DISABLED' }
        return success(true)
      }
      if (path === '/mes/maintenance-item/update') {
        assert.equal(String(body.id), itemId)
        itemStatus = body.status
        return success(true)
      }
      throw new Error(`unexpected PUT ${path}`)
    }
  }
  const dependencies = {
    login: async () => 'unit-token',
    createApiClient: () => api,
    openRoute: async () => {},
    saveScreenshot: async (page, output, name) => screenshots.push(name),
    ...(runVersionedInspectionTasks ? { runVersionedInspectionTasks } : {})
  }
  const context = {
    caseId: 'MAINT-002',
    caseRecord,
    record: {},
    outputDir: '/unused',
    page: {
      locator: (selector) => selector === '.el-form-item__label'
        ? { filter: ({ hasText }) => ({ label: hasText }) }
        : node,
      getByRole: () => dialog
    }
  }
  try {
    const result = await runCase(context, dependencies)
    return { result, caseRecord, deleted, deletedPaths, screenshots, itemStatus, itemExists, deviceExists, plan }
  } catch (error) {
    if (!captureError) throw error
    return { error, caseRecord, deleted, deletedPaths, screenshots, itemStatus, itemExists, deviceExists, plan }
  }
}

test('master case verifies all roots, exact standard fields and the dialog without promoting version governance', async () => {
  const { result, caseRecord, deleted, screenshots } = await runMaster()
  assert.deepEqual(deleted, ['1', '2', '3'])
  assert.equal(caseRecord.checks.every((item) => item.passed), true)
  assert.equal(result.partial, true)
  assert.match(result.note, /项目标准任务快照|新版本治理尚未闭环/)
  assert.deepEqual(screenshots, ['maint-002-root-and-master', 'maint-002-master-fields'])
  assert.equal(caseRecord.checks.at(-1).name, '维保项目测试数据已清理')
})

test('root deletion fails its evidence for a service error or changed root facts', async () => {
  for (const options of [{ rejection: 500 }, { changedRoot: true }]) {
    const { caseRecord } = await runMaster(options)
    const rootChecks = caseRecord.checks.filter((item) => item.name.includes('系统根分类删除'))
    assert.equal(rootChecks.length, 3)
    assert.equal(rootChecks.every((item) => item.passed === false), true)
  }
})

test('missing master standard fields cannot pass exact readback', async () => {
  for (const changedField of ['itemCode', 'execRequirement', 'resultType', 'standardHours',
    'attachmentRequired', 'abnormalAction']) {
    const { caseRecord } = await runMaster({ changedField })
    assert.equal(caseRecord.checks.find((item) =>
      item.name.includes('完整标准字段精确回读')).passed, false, changedField)
    assert.equal(caseRecord.checks.at(-1).passed, true)
  }
})

test('master cleanup rejects a successful delete response when the item remains readable', async () => {
  await assert.rejects(runMaster({ retainedItem: true }), /测试数据清理失败/)
})

test('device fixture presence reaches the versioned project path', async () => {
  let called = false
  const outcome = await runMaster({
    deviceAvailable: true,
    runVersionedInspectionTasks: async () => {
      called = true
    }
  })
  assert.equal(called, true)
  assert.equal(outcome.deviceExists, false)
  assert.equal(outcome.itemExists, false)
  assert.ok(outcome.deletedPaths.includes('/iot/device/delete?id=9007199254740994'))
  assert.ok(outcome.deletedPaths.includes('/mes/maintenance-item/delete?id=9007199254740993'))
})

test('publish failure removes the unpublished draft plan before deleting the project item', async () => {
  const outcome = await runMaster({
    deviceAvailable: true,
    captureError: true,
    runVersionedInspectionTasks: async ({ api, fixture }) => {
      const response = await api.putBusiness(`/mes/maintenance-plan/publish?id=${fixture.planId}`, {
        publishFailure: true
      })
      if (response.code !== 0) throw new Error('发布失败')
    }
  })
  assert.match(outcome.error.message, /发布失败/)
  assert.equal(outcome.itemExists, false)
  assert.equal(outcome.itemStatus, 0)
  assert.ok(outcome.deletedPaths.includes('/mes/maintenance-plan/delete?id=9007199254740995'))
  assert.ok(outcome.deletedPaths.includes('/mes/maintenance-item/delete?id=9007199254740993'))
  assert.ok(outcome.deletedPaths.indexOf('/mes/maintenance-plan/delete?id=9007199254740995') <
    outcome.deletedPaths.indexOf('/mes/maintenance-item/delete?id=9007199254740993'))
  assert.equal(outcome.caseRecord.checks.some((item) =>
    item.name === '维保项目测试数据已清理' && item.passed
  ), true)
})

test('successful publish disables the plan and retains the referenced project', async () => {
  const outcome = await runMaster({
    deviceAvailable: true,
    runVersionedInspectionTasks: async ({ api, fixture }) => {
      const response = await api.putBusiness(`/mes/maintenance-plan/publish?id=${fixture.planId}`)
      assert.equal(response.code, 0)
    }
  })
  assert.equal(outcome.itemExists, true)
  assert.equal(outcome.itemStatus, 1)
  assert.equal(outcome.plan.status, 'DISABLED')
  assert.equal(outcome.deletedPaths.includes('/mes/maintenance-item/delete?id=9007199254740993'), false)
  assert.equal(outcome.caseRecord.checks.some((item) =>
    item.name === '维保项目隔离夹具已保留' && item.passed
  ), true)
})
