import test from 'node:test'
import assert from 'node:assert/strict'
import { runCase } from '../suites/iot-maintenance.mjs'

const success = (data) => ({ code: 0, data })

async function runMaster ({ rejection = 400, changedRoot = false, changedField, retainedItem = false } = {}) {
  const roots = ['REPAIR', 'UPKEEP', 'INSPECT'].map((categoryRoot, index) => ({
    id: String(index + 1), categoryRoot, systemRoot: true
  }))
  const gets = new Map()
  const deleted = []
  const screenshots = []
  let saved
  const caseRecord = { checks: [], notes: [], evidence: [] }
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
      const id = new URL(path, 'http://test').searchParams.get('id')
      if (id === '9007199254740993') return success({
        ...saved, ...(changedField ? { [changedField]: null } : {})
      })
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
      assert.equal(path, '/mes/maintenance-item/create')
      saved = {
        ...body, id: '9007199254740993', systemRoot: false, version: 1, publishStatus: 0
      }
      return success(saved.id)
    },
    async deleteBusiness (path) {
      assert.equal(path, '/mes/maintenance-item/delete?id=9007199254740993')
      return success(true)
    }
  }
  const result = await runCase({
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
  }, {
    login: async () => 'unit-token',
    createApiClient: () => api,
    openRoute: async () => {},
    saveScreenshot: async (page, output, name) => screenshots.push(name)
  })
  return { result, caseRecord, deleted, screenshots }
}

test('master case verifies all roots, exact standard fields and the dialog without promoting version governance', async () => {
  const { result, caseRecord, deleted, screenshots } = await runMaster()
  assert.deepEqual(deleted, ['1', '2', '3'])
  assert.equal(caseRecord.checks.every((item) => item.passed), true)
  assert.equal(result.partial, true)
  assert.match(result.note, /新版本治理尚未闭环/)
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
