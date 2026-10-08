import assert from 'node:assert/strict'
import { executionMarker, ExecutionWorkflowFixture } from './mes-execution-write.mjs'

const unwrap = (response, label = 'MES APS fixture') => {
  assert(
    response?.code === 200 || response?.code === 0,
    `${label} 必须业务成功：${JSON.stringify(response)}`
  )
  return response && Object.prototype.hasOwnProperty.call(response, 'data')
    ? response.data
    : response
}

/**
 * 为 APS 用例创建专属工单、排产版本与排产计算结果。
 *
 * 数据全部走正式接口写入，跑完清理工单/生产计划与排产版本，
 * 保证不同 runner 之间不共享排产样本。
 */
export class ApsSchedulingFixture {
  constructor (api, record, caseId, { calculate = true } = {}) {
    this.api = api
    this.record = record
    this.caseId = caseId
    this.marker = executionMarker(caseId)
    this.calculate = calculate
    this.execution = new ExecutionWorkflowFixture(api, record, caseId, {
      schedule: false
    })
  }

  async setup (caseRecord) {
    await this.execution.setup(caseRecord)
    const work = this.execution.works[0]
    this.versionId = String(unwrap(await this.api.postBusiness('/mes/aps/scheduling/create', {
      schedulingVersionName: `${this.marker}-排产版本`,
      schedulingStartDate: new Date().toISOString().slice(0, 10),
      schedulingDayCount: 7,
      capacityLimitType: 'equipment',
      workOrderIds: work.id
    }), '创建排产版本'))
    assert(/^[0-9]+$/.test(this.versionId), '排产版本主键必须为数字')
    if (this.calculate) {
      this.calculation = unwrap(await this.api.postBusiness(
        '/mes/aps/scheduling/calculate',
        {
          versionId: Number(this.versionId),
          workOrders: [{
            workOrderId: work.id,
            sortOrder: 1,
            processId: this.execution.route.id,
            processName: this.execution.route.identity
          }],
          forceSchedule: true,
          algorithmType: 'RULE_HEURISTIC',
          compareAlgorithms: true
        }
      ), '排产计算')
    }
    return this
  }

  async cleanup (caseRecord) {
    if (this.versionId) {
      try {
        await this.api.deleteBusiness(
          `/mes/aps/scheduling/delete?id=${encodeURIComponent(this.versionId)}`
        )
      } catch (error) {
        caseRecord.notes.push(`清理排产版本 ${this.versionId} 失败：${error.message}`)
      }
    }
    await this.execution.cleanup(caseRecord)
  }
}
