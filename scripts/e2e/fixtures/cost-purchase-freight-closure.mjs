import { config } from '../config/index.mjs'
import { createApiClient, matchesExpectedBusinessRejection } from '../lib/api.mjs'
import { assertBusinessSuccess } from '../lib/assertions.mjs'
import { launchBrowser, loginWithCredentials } from '../lib/browser.mjs'
import { verifyPurchaseFreightPage } from './cost-purchase-freight-page.mjs'

export const COST_PURCHASE_FREIGHT_CHECKS = Object.freeze({
  wmsSource: 'COST-011 专属应付 freight 复用已审核采购入库对应唯一WMS来源',
  expense: 'COST-011 已生效应付 freight 精确映射PURCHASE_FREIGHT并写入expenseAmount',
  shared: 'COST-011 采购费用与采购入库共用PURCHASE来源快照且刷新保持DRAFT',
  zero: 'COST-011 未生效或零值应付不进入确认采购费用来源'
})

const dataOf = (payload, label) => assertBusinessSuccess(payload, label).data

const exactId = (value, label) => {
  const text = typeof value === 'string'
    ? value
    : Number.isSafeInteger(value) ? String(value) : ''
  if (!/^[1-9]\d*$/.test(text) || BigInt(text) > 9223372036854775807n) {
    throw new Error(`${label} 未返回精确数字 ID`)
  }
  return text
}

const money = (value, label = '金额') => {
  if ((typeof value !== 'number' && typeof value !== 'string') ||
      String(value).trim() === '') {
    throw new Error(`${label}缺少明确金额`)
  }
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${label}不是有限金额：${value}`)
  return number.toFixed(2)
}

const sameMoney = (left, right) => money(left) === money(right)

const isOne = (value) => value === true || value === 1 || String(value) === '1'

const sourceBillTypeOf = (row) => String(row?.sourceBillType ?? row?.srcBillType ?? '')
const sourceBillIdOf = (row) => String(row?.sourceBillId ?? row?.srcBillId ?? '')

const pageRows = (payload, label) => {
  const data = dataOf(payload, label)
  const rows = Array.isArray(data?.list)
    ? data.list
    : Array.isArray(data?.records) ? data.records : null
  if (!rows || !Number.isSafeInteger(Number(data?.total)) ||
      Number(data.total) < rows.length) {
    throw new Error(`${label}缺少明确 list/records 与 total 分页结构`)
  }
  return rows
}

const arrayData = (payload, label) => {
  const data = dataOf(payload, label)
  if (!Array.isArray(data)) throw new Error(`${label}未返回数组`)
  return data
}

const currentPayable = async (api, payableId, label) =>
  dataOf(
    await api.getBusiness(`/finance/finPayable/queryById?id=${encodeURIComponent(payableId)}`),
    label
  )

const payableEntries = async (api, payable, label) => {
  const embedded = Array.isArray(payable?.finPayableEntryList)
    ? payable.finPayableEntryList
    : []
  const rows = embedded.length
    ? embedded
    : arrayData(
        await api.getBusiness(
          `/finance/finPayable/queryFinPayableSubByMainId?id=${encodeURIComponent(payable.id)}`
        ),
        `${label}明细`
      )
  if (!rows.length) throw new Error(`${label}明细为空，不能证明 freight 已保存`)
  return rows
}

const readOwnedWmsSource = async ({ api, fixture }) => {
  const purchaseIn = dataOf(
    await api.getBusiness(`/erp/purchase-in/get?id=${encodeURIComponent(fixture.purchaseInId)}`),
    'COST-011采购入库详情'
  )
  const purchaseItem = purchaseIn?.items?.find((row) =>
    String(row?.productId) === String(fixture.materialId))
  if (!purchaseItem?.id) throw new Error('COST-011采购入库缺少本轮物料明细 ID')
  const purchaseItemId = exactId(purchaseItem.id, 'COST-011采购入库明细')

  const page = await api.getBusiness(
    `/mes/stkIo/list?pageNo=1&pageSize=100&srcBillType=ErpPurchaseIn&` +
    `srcBillId=${encodeURIComponent(fixture.purchaseInId)}`
  )
  const rows = pageRows(page, 'COST-011 WMS来源分页')
  const matches = rows.filter((row) =>
    sourceBillTypeOf(row) === 'ErpPurchaseIn' &&
    sourceBillIdOf(row) === String(fixture.purchaseInId) &&
    String(row?.stockIoType ?? '') === '101' &&
    isOne(row?.isEffective) &&
    !isOne(row?.isVoided)
  )
  if (matches.length !== 1) {
    throw new Error(`COST-011未唯一命中已审核WMS采购入库：matches=${matches.length}`)
  }
  const wms = matches[0]
  const wmsId = exactId(wms.id, 'COST-011 WMS入库')
  const detail = dataOf(
    await api.getBusiness(`/mes/stkIo/queryById?id=${encodeURIComponent(wmsId)}`),
    'COST-011 WMS入库详情'
  )
  const entries = arrayData(
    await api.getBusiness(`/mes/stkIo/queryEntryByMainId?id=${encodeURIComponent(wmsId)}`),
    'COST-011 WMS入库明细'
  )
  const matchedEntries = entries.filter((row) =>
    String(row?.srcEntryId ?? '') === purchaseItemId &&
    String(row?.materialId ?? '') === String(fixture.materialId) &&
    String(row?.unitId ?? '') === String(fixture.unitId)
  )
  if (matchedEntries.length !== 1 || !isOne(detail?.isEffective) ||
      isOne(detail?.isVoided) ||
      sourceBillTypeOf(detail) !== 'ErpPurchaseIn' ||
      sourceBillIdOf(detail) !== String(fixture.purchaseInId) ||
      String(detail?.stockIoType ?? '') !== '101') {
    throw new Error('COST-011 WMS来源详情或明细未形成唯一有效采购入库事实')
  }
  const entry = matchedEntries[0]
  const entryId = exactId(entry.id, 'COST-011 WMS入库明细')
  return {
    purchaseIn,
    purchaseItem,
    purchaseItemId,
    wms: { ...detail, id: wmsId },
    entry: { ...entry, id: entryId }
  }
}

export const buildPurchaseFreightPayable = ({
  fixture, wmsSource, freight, suffix = 'POSITIVE'
}) => {
  const amount = money(freight, `COST-011 ${suffix} freight`)
  // fin_payable.bill_no is varchar(50); retain a run-unique marker without
  // sending an overlong fixture value that would surface as a database 500.
  const billNo = `E2E-C11-${String(fixture.runId).slice(-12)}-${fixture.suffix}-${suffix}`
  if (billNo.length > 50) {
    throw new Error(`COST-011应付单号超过 fin_payable.bill_no 长度限制：${billNo.length}`)
  }
  const sourceNo = String(wmsSource.wms.billNo || wmsSource.wms.no || wmsSource.wms.id)
  const sourceType = 'MesStkIoDTO:101'
  const entry = {
    entryNo: 1,
    billNo,
    srcBillType: sourceType,
    srcBillId: String(wmsSource.wms.id),
    srcEntryId: String(wmsSource.entry.id),
    srcNo: `${sourceNo}:1`,
    remark: `${fixture.remark}:${suffix}:entry`,
    materialId: String(fixture.materialId),
    unitId: String(fixture.unitId),
    qty: Number(wmsSource.entry.qty || wmsSource.purchaseItem.count || 0),
    price: 0,
    amt: amount,
    checkedAmt: 0,
    afterSaveCheckedAmt: 0,
    freight: amount,
    taxPercent: 0,
    taxPrice: 0
  }
  return {
    billNo,
    sourceType,
    amount,
    body: {
      billNo,
      billDate: `${fixture.month}-06`,
      payableType: '201',
      supplierId: String(fixture.supplierId),
      amt: amount,
      checkedAmt: 0,
      afterSaveCheckedAmt: 0,
      isRubric: 0,
      isAuto: 0,
      isVoided: 0,
      srcBillType: sourceType,
      srcBillId: String(wmsSource.wms.id),
      srcNo: sourceNo,
      remark: `${fixture.remark}:${suffix}`,
      finPayableEntryList: [entry]
    },
    entry
  }
}

const readPayableByBillNo = async (api, billNo, label) => {
  const rows = pageRows(
    await api.getBusiness(
      `/finance/finPayable/list/201?pageNo=1&pageSize=100&billNo=${encodeURIComponent(billNo)}`
    ),
    `${label}分页`
  )
  const matches = rows.filter((row) => String(row?.billNo) === billNo)
  if (matches.length !== 1) throw new Error(`${label}未唯一回读 billNo=${billNo}`)
  return exactId(matches[0].id, `${label}主单`)
}

const createPayable = async ({ api, fixture, wmsSource, freight, suffix, register }) => {
  const payload = buildPurchaseFreightPayable({ fixture, wmsSource, freight, suffix })
  // add/save creates the formal header first. edit/submit persists the entry
  // before any workflow is started, so BPM variables contain real details.
  await api.postBusiness('/finance/finPayable/add/save', payload.body)
  const payableId = await readPayableByBillNo(api, payload.billNo, `COST-011 ${suffix}应付`)
  // Register the saved header before submission/readback can fail.
  const owned = { id: payableId, billNo: payload.billNo, amount: payload.amount }
  register(owned)
  const editBody = {
    ...payload.body,
    id: payableId,
    billStage: '12',
    isEffective: 0,
    isVoided: 0
  }
  await api.putBusiness('/finance/finPayable/edit/submit', editBody)
  const payable = await currentPayable(api, payableId, `COST-011 ${suffix}应付回读`)
  const entries = await payableEntries(api, payable, `COST-011 ${suffix}应付`)
  const ownedEntries = entries.filter((row) =>
    String(row?.mid) === payableId &&
    String(row?.srcBillId) === String(wmsSource.wms.id) &&
    String(row?.srcEntryId) === String(wmsSource.entry.id))
  if (ownedEntries.length !== 1 ||
      String(payable.srcBillType) !== payload.sourceType ||
      String(payable.srcBillId) !== String(wmsSource.wms.id) ||
      String(payable.supplierId) !== String(fixture.supplierId) ||
      !sameMoney(payable.amt, payload.amount) ||
      !sameMoney(ownedEntries[0].freight, payload.amount)) {
    throw new Error(`COST-011 ${suffix}应付来源、金额或明细未精确回读`)
  }
  return Object.assign(owned, {
    entryId: exactId(ownedEntries[0].id, `COST-011 ${suffix}应付明细`),
    processInstanceId: payable.processInstanceId || null,
    payable,
    entry: ownedEntries[0]
  })
}

const taskRows = (payload, label) => {
  const data = dataOf(payload, label)
  const rows = Array.isArray(data) ? data : data?.list || data?.records
  if (!Array.isArray(rows)) throw new Error(`${label}未返回任务数组`)
  return rows
}

const activeTasks = (rows) => rows.filter((row) =>
  row?.endTime == null && Number(row?.status) === 1)

const waitFor = async (read, predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await read()
    if (predicate(latest)) return latest
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`BLOCKED: ${label}等待超时：${JSON.stringify(latest).slice(0, 1000)}`)
}

const payableApproverCredentials = () => [
  [config.purchaseApproverUsername, config.purchaseApproverPassword],
  [config.financeApproverUsername, config.financeApproverPassword],
  [config.finalApproverUsername, config.finalApproverPassword],
  [config.warehouseApproverUsername, config.warehouseApproverPassword],
  [config.warehouseFinalApproverUsername, config.warehouseFinalApproverPassword]
].filter(([username, password]) => username && password)

/**
 * Approve only the actual BPM assignee's task. This is a formal task API
 * action, not the bill-level /bpm/end or /finance/finPayable/check shortcut.
 */
export async function approvePayableBpm ({
  api, processId, record, caseRecord, expectedPayable,
  credentials = payableApproverCredentials()
}) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(processId || ''))) {
    throw new Error('BLOCKED: COST-011应付 BPM 缺少有效流程实例 ID')
  }
  const sessions = new Map()
  const browsers = new Set()
  const close = async () => {
    for (const browser of browsers) await browser.browser.close().catch(() => {})
  }
  const readTasks = () => api.getBusiness(
    `/bpm/task/list-by-process-instance-id?processInstanceId=${encodeURIComponent(processId)}`
  ).then((payload) => taskRows(payload, 'COST-011应付BPM任务'))
  try {
    for (let step = 0; step < 12; step++) {
      const rows = await readTasks()
      const active = activeTasks(rows)
      if (!active.length) return
      for (const task of active) {
        const assigneeId = exactId(task?.assigneeUser?.id ?? task?.assignee,
          'COST-011应付BPM实际审批人')
        const user = task?.assigneeUser?.username
          ? task.assigneeUser
          : dataOf(await api.getBusiness(`/system/user/get?id=${assigneeId}`),
              'COST-011应付BPM审批人')
        const username = String(user?.username || '')
        const credential = credentials.find(([candidate]) => candidate === username)
        if (!credential) {
          throw new Error(`BLOCKED: COST-011实际应付审批账号无本地凭据：username=${username}`)
        }
        let session = sessions.get(username)
        if (!session) {
          const browser = await launchBrowser({ headed: !config.headless, record })
          browsers.add(browser)
          const auth = await loginWithCredentials(browser.page, {
            tenantName: config.tenantName,
            username: credential[0],
            password: credential[1]
          }, { returnContext: true })
          if (String(auth?.tenantId || '') !== '1') {
            throw new Error(`BLOCKED: COST-011审批账号租户不一致：username=${username}`)
          }
          const approverApi = createApiClient({
            token: auth.token, tenantId: '1', record
          })
          const permission = dataOf(
            await approverApi.getPermissionInfo(),
            'COST-011应付审批账号权限'
          )
          if (String(permission?.user?.id) !== assigneeId ||
              String(permission?.user?.username) !== username) {
            throw new Error(`BLOCKED: COST-011实际BPM assignee身份不一致：username=${username}`)
          }
          session = { api: approverApi }
          sessions.set(username, session)
        }
        const todo = dataOf(await session.api.getBusiness(
          `/bpm/task/my-todo?processInstanceId=${encodeURIComponent(processId)}` +
          `&taskId=${encodeURIComponent(task.id)}`
        ), 'COST-011应付审批准确待办')
        if (String(todo?.id) !== String(task.id) || Number(todo?.status) !== 1) {
          throw new Error(`BLOCKED: COST-011审批账号未收到准确待办：taskId=${task.id}`)
        }
        const approvalDetail = dataOf(await session.api.getBusiness(
          `/bpm/process-instance/get-approval-detail?processInstanceId=${encodeURIComponent(processId)}` +
          `&taskId=${encodeURIComponent(task.id)}`
        ), 'COST-011应付审批详情')
        const variables = approvalDetail?.processInstance?.formVariables ||
          approvalDetail?.formVariables || {}
        const detailEntries = variables.entryList || variables.finPayableEntryList
        if (!Array.isArray(detailEntries) || detailEntries.length === 0 ||
            (expectedPayable && String(variables.billNo || '') !== String(expectedPayable.billNo))) {
          throw new Error(
            `BLOCKED: COST-011审批详情为空或未绑定专属应付：` +
            `processInstanceId=${processId}; taskId=${task.id}`
          )
        }
        await session.api.putBusiness('/bpm/task/approve', {
          id: task.id,
          reason: 'COST-011 E2E正式应付freight审批'
        })
        await waitFor(
          readTasks,
          (latest) => {
            const current = latest.find((row) => String(row.id) === String(task.id))
            return current && (current.endTime != null || Number(current.status) !== 1)
          },
          60000,
          `COST-011审批任务 ${task.id}`
        )
        caseRecord.evidence.push(
          `COST-011正式BPM审批：processInstanceId=${processId}; taskId=${task.id}; username=${username}`
        )
      }
    }
    throw new Error(`BLOCKED: COST-011应付BPM超过12个节点：processInstanceId=${processId}`)
  } finally {
    await close()
  }
}

const ensureEffective = async ({
  api, payable, record, caseRecord, dependencies
}) => {
  let current = await currentPayable(api, payable.id, 'COST-011应付生效状态')
  if (isOne(current?.isEffective)) return current
  if (current?.processInstanceId && ['22', '23'].includes(String(current.billStage))) {
    await (dependencies.approvePayableBpm || approvePayableBpm)({
      api, processId: current.processInstanceId, record, caseRecord,
      expectedPayable: payable,
      credentials: dependencies.payableApproverCredentials
    })
  } else if (String(current?.billStage) === '14' || !current?.processInstanceId) {
    await api.putBusiness('/finance/finPayable/check', {
      id: payable.id,
      approvalResultType: '1',
      approvalRemark: 'COST-011 E2E正式应付freight核批'
    })
  } else {
    throw new Error(`COST-011应付进入未支持审批状态：stage=${current?.billStage}`)
  }
  current = await waitFor(
    () => currentPayable(api, payable.id, 'COST-011应付审批后回读'),
    (value) => isOne(value?.isEffective),
    60000,
    `COST-011应付 ${payable.id} 生效`
  )
  return current
}

const refreshPurchaseSnapshot = async (api, periodId, label) => {
  const response = await api.postBusiness(
    `/cost/periods/${encodeURIComponent(periodId)}/source-snapshot/purchase/refresh`
  )
  const snapshot = response?.data
  if (!snapshot || snapshot.snapshotKey !== 'PURCHASE' || snapshot.status !== 'DRAFT' ||
      !Array.isArray(snapshot.lines) || snapshot.lines.length === 0) {
    throw new Error(`${label}未返回非空PURCHASE DRAFT快照`)
  }
  return snapshot
}

export const assertPurchaseFreightSnapshot = ({
  snapshot, positive, zero, wmsSource
}) => {
  if (!snapshot || snapshot.snapshotKey !== 'PURCHASE' ||
      snapshot.status !== 'DRAFT' || !Array.isArray(snapshot.lines) ||
      snapshot.lines.length === 0) {
    throw new Error('COST-011采购来源快照必须是非空DRAFT')
  }
  const freightLines = snapshot.lines.filter((row) =>
    row?.sourceType === 'PURCHASE_FREIGHT')
  const positiveLines = freightLines.filter((row) =>
    String(row?.sourceId) === String(positive.id) &&
    String(row?.sourceLineId) === String(positive.entryId))
  if (positiveLines.length !== 1) {
    throw new Error(`COST-011专属正数freight来源未唯一命中：${positiveLines.length}`)
  }
  const line = positiveLines[0]
  if (String(line.sourceNo) !== positive.billNo ||
      String(line.sourceVersion) !== 'MesStkIoDTO:101' ||
      line.componentCode !== 'PURCHASE_FREIGHT' ||
      Number(line.quantity) !== 0 ||
      Number(line.materialAmount) !== 0 ||
      !sameMoney(line.expenseAmount, positive.amount)) {
    throw new Error('COST-011 PURCHASE_FREIGHT来源字段或金额不精确')
  }
  if (freightLines.some((row) =>
    String(row.sourceId) === String(zero.id) ||
    Number(row.expenseAmount || 0) <= 0)) {
    throw new Error('COST-011零值或非正费用进入了确认采购费用来源')
  }
  const receipt = snapshot.lines.filter((row) =>
    row?.sourceType === 'PURCHASE_RECEIPT' &&
    String(row.sourceId) === String(wmsSource.purchaseIn.id) &&
    String(row.sourceLineId) === String(wmsSource.purchaseItemId))
  if (receipt.length !== 1) {
    throw new Error('COST-011专属采购入库与freight未共用同一PURCHASE快照')
  }
  return { freightLine: line, receiptLine: receipt[0] }
}

const cleanupPayable = async ({ api, payable, caseRecord }) => {
  const cleanup = { headerDeleted: false, complete: false }
  payable.cleanup = cleanup
  const current = await currentPayable(api, payable.id, 'COST-011清理前应付')
  if (isOne(current?.isEffective) || current?.processInstanceId ||
      !['12', '14'].includes(String(current?.billStage))) {
    await api.putBusiness('/finance/finPayable/void', { id: payable.id })
    const afterVoid = await currentPayable(api, payable.id, 'COST-011应付作废回读')
    if (isOne(afterVoid?.isEffective)) {
      throw new Error(`COST-011应付作废后仍为生效：${payable.id}`)
    }
  }
  await api.deleteBusiness(`/finance/finPayable/delete?id=${encodeURIComponent(payable.id)}`)
  const notFound = {
    code: 500,
    message: '未找到对应数据',
    allowServiceCode: true
  }
  const afterDelete = await api.get(
    `/finance/finPayable/queryById?id=${encodeURIComponent(payable.id)}`,
    {
      // Deletion is verified by reading the same formal endpoint. A 500
      // business response with the exact not-found message is expected here;
      // other transport or service failures remain fail-closed.
      expectedBusinessRejection: notFound
    }
  )
  if (!(afterDelete?.success !== true && afterDelete?.ok !== true &&
      matchesExpectedBusinessRejection(afterDelete, notFound))) {
    if (dataOf(afterDelete, 'COST-011应付删除回读') !== null) {
      throw new Error(`COST-011应付正式删除后仍可读取：${payable.id}`)
    }
  }
  cleanup.headerDeleted = true
  const remaining = arrayData(await api.getBusiness(
    `/finance/finPayable/queryFinPayableSubByMainId?id=${encodeURIComponent(payable.id)}`
  ), 'COST-011删除后应付明细回读')
  cleanup.remainingEntryIds = remaining.map((row) =>
    exactId(row?.id, 'COST-011删除后残留应付明细'))
  if (remaining.length) {
    throw new Error(
      `COST-011应付主单已删除但明细残留：payableId=${payable.id}; ` +
      `entryIds=${cleanup.remainingEntryIds.join(',')}`
    )
  }
  cleanup.complete = true
  caseRecord.evidence.push(`COST-011专属应付已通过正式接口清理：payableId=${payable.id}`)
}

export async function runCostPurchaseFreightClosure ({
  api, page, outputDir, record, caseRecord, fixture, dependencies = {}
}) {
  const settings = dependencies.config || config
  if (settings.target !== 'local' || String(settings.tenantId) !== '1' ||
      String(record?.environment?.tenantId) !== '1' ||
      fixture?.runId !== record?.runId || fixture?.tenantId !== '1' ||
      !fixture?.purchaseInId || !fixture?.periodId) {
    throw new Error('BLOCKED: COST-011仅允许本地tenant1本轮采购场景夹具')
  }
  const wmsSource = await readOwnedWmsSource({ api, fixture })
  let positive
  let zero
  const closure = {
    runId: record.runId,
    tenantId: '1',
    periodId: String(fixture.periodId),
    wmsId: String(wmsSource.wms.id),
    wmsEntryId: String(wmsSource.entry.id),
    purchaseInId: String(wmsSource.purchaseIn.id),
    purchaseInEntryId: String(wmsSource.purchaseItemId),
    positive,
    zero,
    complete: false
  }
  caseRecord.fixtures = { ...(caseRecord.fixtures || {}), costPurchaseFreight: closure }
  let primaryError
  try {
    positive = await createPayable({
      api, fixture, wmsSource, freight: dependencies.positiveFreight ?? 12.34,
      suffix: 'POSITIVE',
      register: (owned) => { positive = closure.positive = owned }
    })
    closure.positive = positive
    zero = await createPayable({
      api, fixture, wmsSource, freight: 0, suffix: 'ZERO',
      register: (owned) => { zero = closure.zero = owned }
    })
    closure.zero = zero
    const positiveAfterApproval = await ensureEffective({
      api, payable: positive, record, caseRecord, dependencies
    })
    const zeroAfterApproval = await ensureEffective({
      api, payable: zero, record, caseRecord, dependencies
    })
    closure.positive.payable = positiveAfterApproval
    closure.zero.payable = zeroAfterApproval
    const snapshot = await refreshPurchaseSnapshot(api, fixture.periodId, 'COST-011正数费用刷新')
    const proof = assertPurchaseFreightSnapshot({
      snapshot, positive, zero, wmsSource
    })
    if (page || dependencies.verifyBrowser) {
      closure.browser = await (dependencies.verifyBrowser || verifyPurchaseFreightPage)({
        page, outputDir, record, fixture, snapshot, positive, zero
      })
      caseRecord.checks.push({
        name: 'COST-011真实采购页面调用正式刷新并显示同期间入库及12.34费用，无共享草稿写入',
        passed: true,
        details: `periodId=${fixture.periodId}; payableId=${positive.id}; expense=${positive.amount}`
      })
    }
    caseRecord.checks.push({
      name: COST_PURCHASE_FREIGHT_CHECKS.wmsSource,
      passed: true,
      details: `wmsId=${wmsSource.wms.id}; wmsEntryId=${wmsSource.entry.id}; ` +
        `purchaseInId=${wmsSource.purchaseIn.id}; sourceType=ErpPurchaseIn`
    })
    caseRecord.checks.push({
      name: COST_PURCHASE_FREIGHT_CHECKS.expense,
      passed: true,
      details: `payableId=${positive.id}; entryId=${positive.entryId}; ` +
        `freight=${positive.amount}; expenseAmount=${proof.freightLine.expenseAmount}`
    })
    caseRecord.checks.push({
      name: COST_PURCHASE_FREIGHT_CHECKS.shared,
      passed: true,
      details: `snapshotKey=PURCHASE; status=${snapshot.status}; ` +
        `receiptSource=${wmsSource.purchaseIn.id}:${wmsSource.purchaseItemId}; ` +
        `freightSource=${positive.id}:${positive.entryId}`
    })
    caseRecord.checks.push({
      name: COST_PURCHASE_FREIGHT_CHECKS.zero,
      passed: true,
      details: `zeroPayable=${zero.id}; zeroFreightLinesExcluded=true; ` +
        `positiveFreightLines=${snapshot.lines.filter((row) => row.sourceType === 'PURCHASE_FREIGHT').length}`
    })
    caseRecord.evidence.push(
      `COST-011专属采购费用闭环：${JSON.stringify({
        periodId: fixture.periodId,
        wmsId: wmsSource.wms.id,
        payableId: positive.id,
        payableEntryId: positive.entryId,
        freight: positive.amount
      })}`
    )
  } catch (error) {
    primaryError = error
  }

  const cleanupErrors = []
  const ownedPayables = [positive, zero].filter(Boolean)
  for (const payable of ownedPayables) {
    try {
      await cleanupPayable({ api, payable, caseRecord })
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (ownedPayables.length) {
    try {
      const afterCleanup = await refreshPurchaseSnapshot(
        api, fixture.periodId, 'COST-011清理后采购费用刷新'
      )
      const residual = afterCleanup.lines.filter((row) =>
        row.sourceType === 'PURCHASE_FREIGHT' &&
        ownedPayables.some((payable) => payable.id === String(row.sourceId)))
      if (residual.length) throw new Error(
        `COST-011清理后仍有专属费用来源：${residual.map((row) => row.sourceId).join(',')}`
      )
      if (!afterCleanup.lines.some((row) =>
        row.sourceType === 'PURCHASE_RECEIPT' &&
        String(row.sourceId) === String(wmsSource.purchaseIn.id) &&
        String(row.sourceLineId) === String(wmsSource.purchaseItemId))) {
        throw new Error('COST-011清理后专属采购入库明细来源丢失')
      }
      caseRecord.checks.push({
        name: 'COST-011专属应付清理后费用行消失且采购入库来源保留',
        passed: cleanupErrors.length === 0,
        details: `remainingLines=${afterCleanup.lines.length}; status=${afterCleanup.status}`
      })
    } catch (error) {
      cleanupErrors.push(error)
    }
  } else {
    cleanupErrors.push(new Error('COST-011未创建出可用于清理回读的专属应付'))
  }
  if (cleanupErrors.length) {
    const message = cleanupErrors.map((error) => error.message).join('；')
    caseRecord.checks.push({
      name: 'COST-011专属应付清理后费用行消失且采购入库来源保留',
      passed: false,
      details: message
    })
    throw new AggregateError(
      [primaryError, ...cleanupErrors].filter(Boolean),
      `COST-011正式清理失败：${message}` +
        (primaryError ? `；原始错误：${primaryError.message}` : '')
    )
  }
  if (primaryError) throw primaryError
  closure.complete = true
  return closure
}
