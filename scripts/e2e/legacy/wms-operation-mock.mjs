// Legacy component contract only; never import this module from the real acceptance runner.
import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['WMS-OP-001']

export const runCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })
  const summary = await api.getBusiness('/wms/operation/task/summary')
  const data = summary?.data ?? summary
  const numericFields = [
    'pendingCount',
    'inProgressCount',
    'completedTodayCount',
    'exceptionTaskCount',
    'openExceptionCount'
  ]
  caseRecord.checks.push({
    name: 'WMS 任务摘要接口真实返回统一字段',
    passed: data && numericFields.every((field) => typeof data[field] === 'number'),
    details: JSON.stringify(data)
  })

  await openRoute(page, '/wireSideWarehouse/stock')
  const summaryPanel = page.locator('[data-testid="wms-operation-summary"]').first()
  await summaryPanel.waitFor({ state: 'visible' })
  const bodyText = await summaryPanel.innerText()
  caseRecord.checks.push({
    name: '现有 WMS 工作台内渲染任务与异常摘要',
    passed: bodyText.includes('任务与异常摘要') && bodyText.includes('待执行'),
    details: bodyText.replace(/\s+/g, ' ').trim()
  })

  const taskPageResponse = await api.getBusiness(
    '/wms/operation/task/page?pageNo=1&pageSize=100&status=PENDING'
  )
  const taskPageData = taskPageResponse?.data ?? taskPageResponse
  const taskPageRows = Array.isArray(taskPageData?.list)
    ? taskPageData.list
    : Array.isArray(taskPageData?.records)
      ? taskPageData.records
      : []
  caseRecord.checks.push({
    name: '统一工作台任务下钻返回任务类型、来源、状态和计划数量',
    passed:
      typeof taskPageData?.total === 'number' &&
      taskPageRows.length <= 100 &&
      taskPageRows.every(
        (task) =>
          task?.id &&
          task?.taskType &&
          task?.status === 'PENDING' &&
          task?.plannedQuantity !== undefined &&
          task?.actualQuantity !== undefined
      ),
    details: JSON.stringify({ total: taskPageData?.total, count: taskPageRows.length })
  })
  const taskDrilldown = page.locator('[data-testid="wms-task-drilldown"]').first()
  await taskDrilldown.waitFor({ state: 'visible' })
  const taskDrilldownText = await taskDrilldown.innerText()
  caseRecord.checks.push({
    name: '任务下钻与库存、3D、波次和异常在同一 WMS 工作台内完成联动',
    passed:
      taskDrilldownText.includes('任务下钻') &&
      taskDrilldownText.includes('装箱核验') &&
      new URL(page.url()).pathname === '/wireSideWarehouse/stock',
    details: taskDrilldownText.replace(/\s+/g, ' ').trim()
  })

  // PB-297: 上架建议必须基于现有任务和唯一库存事实返回候选，不在查询阶段写预留。
  const putawayTaskPage = await api.getBusiness(
    '/wms/operation/task/page?pageNo=1&pageSize=100&taskType=PUTAWAY&status=IN_PROGRESS'
  )
  const putawayTaskData = putawayTaskPage?.data ?? putawayTaskPage
  const putawayTasks = Array.isArray(putawayTaskData?.list)
    ? putawayTaskData.list
    : Array.isArray(putawayTaskData?.records)
      ? putawayTaskData.records
      : []
  const putawayTask = putawayTasks.find((task) => task?.id && task?.taskType === 'PUTAWAY')
  if (putawayTask) {
    const putawayDetail = await api.getBusiness(`/wms/operation/task/get?id=${putawayTask.id}`)
    const putawayDetailData = putawayDetail?.data ?? putawayDetail
    const putawayLine = (putawayDetailData?.lines || []).find((line) => line?.id)
    if (putawayLine) {
      const suggestionResponse = await api.postBusiness('/wms/operation/task/putaway/suggest', {
        taskId: putawayTask.id,
        lineId: putawayLine.id
      })
      const suggestion = suggestionResponse?.data ?? suggestionResponse
      caseRecord.checks.push({
        name: 'PB-297 上架建议返回 FIFO 来源、剩余量和可预留库位候选',
        passed:
          suggestion &&
          typeof suggestion.strategy === 'string' &&
          typeof suggestion.remainingQuantity === 'number' &&
          Array.isArray(suggestion.candidates) &&
          suggestion.candidates.every(
            (candidate) =>
              candidate?.locationId &&
              candidate?.areaId &&
              Number(candidate?.reservableQty) >= 0 &&
              (candidate?.capacityQty === null || typeof candidate?.capacityQty === 'number')
          ),
        details: JSON.stringify({
          taskId: putawayTask.id,
          strategy: suggestion?.strategy,
          candidateCount: suggestion?.candidates?.length
        })
      })
    }
  } else {
    const invalid = await api.post('/wms/operation/task/putaway/suggest', {})
    caseRecord.checks.push({
      name: 'PB-297 上架建议接口已挂在现有 WMS 操作入口并执行参数校验',
      passed: invalid?.code !== 0 && String(invalid?.msg || '').includes('参数'),
      details: JSON.stringify(invalid)
    })
  }

  const locationPageResponse = await api.getBusiness(
    '/mes/wms-house-location/page?pageNo=1&pageSize=100'
  )
  const locationPageData = locationPageResponse?.data ?? locationPageResponse
  const locationRows = Array.isArray(locationPageData?.list)
    ? locationPageData.list
    : Array.isArray(locationPageData?.records)
      ? locationPageData.records
      : []
  caseRecord.checks.push({
    name: 'PB-297 库位档案分页返回容量字段，容量为空表示不限制',
    passed:
      locationRows.length <= 100 &&
      locationRows.every(
        (location) =>
          location?.id &&
          (!Object.prototype.hasOwnProperty.call(location, 'capacityQty') ||
            location.capacityQty === null ||
            typeof location.capacityQty === 'number')
      ),
    details: JSON.stringify({ count: locationRows.length })
  })

  // PB-296: ASN in keeps appointment data on the existing arrival-notice fact.
  const arrivalNoticePage = await api.getBusiness(
    '/mes/wms/arrival-notice/page?pageNo=1&pageSize=100&withLines=false'
  )
  const arrivalNoticeData = arrivalNoticePage?.data ?? arrivalNoticePage
  const arrivalNoticeRows = Array.isArray(arrivalNoticeData?.list)
    ? arrivalNoticeData.list
    : Array.isArray(arrivalNoticeData?.records)
      ? arrivalNoticeData.records
      : Array.isArray(arrivalNoticeData)
        ? arrivalNoticeData
        : []
  caseRecord.checks.push({
    name: 'ASN in 预约月台/时段/到货批次字段契约可查询且分页不超过 100',
    passed:
      arrivalNoticeRows.length <= 100 &&
      arrivalNoticeRows.every(
        (notice) =>
          (notice?.appointmentDock === undefined ||
            notice?.appointmentDock === null ||
            typeof notice.appointmentDock === 'string') &&
          (notice?.appointmentStartTime === undefined ||
            notice?.appointmentStartTime === null ||
            typeof notice.appointmentStartTime === 'string') &&
          (notice?.appointmentEndTime === undefined ||
            notice?.appointmentEndTime === null ||
            typeof notice.appointmentEndTime === 'string') &&
          (notice?.arrivalBatchNo === undefined ||
            notice?.arrivalBatchNo === null ||
            typeof notice.arrivalBatchNo === 'string')
      ),
    details: JSON.stringify({ count: arrivalNoticeRows.length })
  })
  caseRecord.checks.push({
    name: 'ASN in 预约字段由同一到货通知事实承载，不引入独立预约单',
    passed: arrivalNoticeRows.every((notice) => notice?.appointmentBookingId === undefined),
    details: JSON.stringify({ count: arrivalNoticeRows.length })
  })

  const dockPageResponse = await api.getBusiness('/wms/dock/page?pageNo=1&pageSize=100')
  const dockPageData = dockPageResponse?.data ?? dockPageResponse
  const dockRows = Array.isArray(dockPageData?.list)
    ? dockPageData.list
    : Array.isArray(dockPageData?.records)
      ? dockPageData.records
      : []
  caseRecord.checks.push({
    name: '收货月台主数据分页返回仓库、容量和档位且不超过 100 条',
    passed:
      typeof dockPageData?.total === 'number' &&
      dockRows.length <= 100 &&
      dockRows.every(
        (dock) =>
          dock?.id &&
          typeof dock?.dockCode === 'string' &&
          typeof dock?.dockName === 'string' &&
          typeof dock?.warehouseId === 'string' &&
          Number(dock?.capacityPerSlot) >= 1 &&
          Number(dock?.slotMinutes) >= 1
      ),
    details: JSON.stringify({ total: dockPageData?.total, count: dockRows.length })
  })
  await openRoute(page, '/wms/settings/dock')
  const dockPage = page.getByText('时段容量', { exact: true }).first()
  await dockPage.waitFor({ state: 'visible' })
  caseRecord.checks.push({
    name: '收货月台维护挂在现有设置-仓储菜单下，不新增平行仓储设置入口',
    passed:
      new URL(page.url()).pathname === '/wms/settings/dock' &&
      (await page.getByRole('button', { name: '新增月台' }).count()) === 1,
    details: `当前路由=${new URL(page.url()).pathname}`
  })
  await openRoute(page, '/wireSideWarehouse/stock')
  caseRecord.checks.push({
    name: '任务摘要不创建第二个工作台路由',
    passed: new URL(page.url()).pathname === '/wireSideWarehouse/stock',
    details: `当前路由=${new URL(page.url()).pathname}`
  })

  // PB-133: 企业侧收货必须复用 ASN 与 WMS createBill，生成 101 草稿而不是直接写库存。
  const receiptNotice = {
    id: 9001,
    code: 'ASN-E2E-001',
    status: 20,
    statusName: '待入库',
    purchaseOrderId: 'po-e2e-001',
    vendorId: 'vendor-e2e-001',
    lines: [
      {
        id: 9101,
        itemId: 'MAT-E2E-001',
        arrivalQuantity: 100,
        receivedQuantity: 20,
        qualifiedQuantity: 0,
        iqcCheckFlag: false,
        unitId: 'unit-each'
      }
    ]
  }
  let receiptRequestBody
  await page.route('**/mes/wms/arrival-notice/page**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: [receiptNotice] })
    })
  })
  await page.route('**/mes/wms/arrival-notice/get**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: receiptNotice })
    })
  })
  await page.route('**/mes/wms/arrival-notice/create-receipt-bill**', async (route) => {
    receiptRequestBody = route.request().postDataJSON()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: 'stk-e2e-101' })
    })
  })
  await openRoute(page, '/mes/wms/arrival-notice')
  await page.getByRole('button', { name: '收货开单' }).click()
  await page.getByPlaceholder('仓库编号（必填）').fill('WH-E2E-001')
  const receiptQtyInput = page.getByRole('spinbutton').last()
  await receiptQtyInput.fill('70')
  await page.getByRole('button', { name: '生成采购入库单' }).click()
  await page.getByText('短收时必须填写差异原因', { exact: false }).waitFor({ state: 'visible' })
  caseRecord.checks.push({
    name: '实际收货少于本次计划数量时前端阻止提交并提示差异原因',
    passed: receiptRequestBody === undefined,
    details: JSON.stringify(receiptRequestBody)
  })
  await page.getByPlaceholder('短收时必填').fill('供应商实际到货少 10')
  await page.getByRole('button', { name: '生成采购入库单' }).click()
  await page
    .getByText('已生成采购入库单草稿：stk-e2e-101', { exact: true })
    .waitFor({ state: 'visible' })
  const receiptLine = Array.isArray(receiptRequestBody) ? receiptRequestBody[0] : undefined
  const requestKeys = Array.isArray(receiptRequestBody)
    ? receiptRequestBody.map((line) => line?.idempotentKey).filter(Boolean)
    : []
  caseRecord.checks.push({
    name: '企业收货开单提交 101 草稿所需仓库、未收数量和统一幂等键',
    passed:
      receiptLine?.lineId === 9101 &&
      Number(receiptLine?.receivedQuantity) === 70 &&
      receiptLine?.warehouseId === 'WH-E2E-001' &&
      receiptLine?.differenceReason === '供应商实际到货少 10' &&
      requestKeys.length === 1 &&
      new Set(requestKeys).size === 1,
    details: JSON.stringify(receiptRequestBody)
  })

  const exceptionPage = await api.getBusiness('/wms/operation/exception/page?pageNo=1&pageSize=100')
  const exceptionData = exceptionPage?.data ?? exceptionPage
  const exceptionRows = Array.isArray(exceptionData?.list)
    ? exceptionData.list
    : Array.isArray(exceptionData?.records)
      ? exceptionData.records
      : []
  const exceptionStatuses = new Set(['OPEN', 'PROCESSING', 'CLOSED'])
  caseRecord.checks.push({
    name: '异常中心分页契约返回合法状态且分页不超过 100',
    passed:
      typeof exceptionData?.total === 'number' &&
      exceptionRows.length <= 100 &&
      exceptionRows.every((item) => item?.status && exceptionStatuses.has(item.status)),
    details: JSON.stringify({ total: exceptionData?.total, count: exceptionRows.length })
  })
  const exceptionPanel = page.locator('[data-testid="wms-exception-center"]').first()
  await exceptionPanel.waitFor({ state: 'visible' })
  const exceptionPanelText = await exceptionPanel.innerText()
  caseRecord.checks.push({
    name: '统一 WMS 工作台内渲染异常中心',
    passed:
      exceptionPanelText.includes('异常中心') &&
      new URL(page.url()).pathname === '/wireSideWarehouse/stock',
    details: exceptionPanelText.replace(/\s+/g, ' ').trim()
  })

  const wavePage = await api.getBusiness('/wms/operation/wave/page?pageNo=1&pageSize=100')
  const waveData = wavePage?.data ?? wavePage
  const waveRows = Array.isArray(waveData?.list)
    ? waveData.list
    : Array.isArray(waveData?.records)
      ? waveData.records
      : []
  const waveStatuses = new Set(['DRAFT', 'RELEASED', 'COMPLETED', 'CANCELLED'])
  caseRecord.checks.push({
    name: '波次分页契约返回合法状态且分页不超过 100',
    passed:
      typeof waveData?.total === 'number' &&
      waveRows.length <= 100 &&
      waveRows.every((wave) => wave?.status && waveStatuses.has(wave.status)),
    details: JSON.stringify({ total: waveData?.total, count: waveRows.length })
  })
  if (waveRows.length > 0) {
    const waveDetailResponse = await api.getBusiness(`/wms/operation/wave/get?id=${waveRows[0].id}`)
    const waveDetail = waveDetailResponse?.data ?? waveDetailResponse
    const waveTasks = Array.isArray(waveDetail?.tasks) ? waveDetail.tasks : []
    caseRecord.checks.push({
      name: '波次详情只归集 PICK 任务且不复制复核流程',
      passed:
        waveTasks.every((task) => task?.taskType === 'PICK') &&
        waveTasks.every((task) => task?.sourceBillType !== 'WmsPackingReview'),
      details: JSON.stringify({ waveId: waveRows[0].id, taskCount: waveTasks.length })
    })
  }
  const wavePanel = page.locator('[data-testid="wms-wave-summary"]').first()
  await wavePanel.waitFor({ state: 'visible' })
  const wavePanelText = await wavePanel.innerText()
  caseRecord.checks.push({
    name: '波次在现有 WMS 单一工作台内展示',
    passed:
      wavePanelText.includes('波次调度') &&
      wavePanelText.includes('自动组波预览') &&
      new URL(page.url()).pathname === '/wireSideWarehouse/stock',
    details: wavePanelText.replace(/\s+/g, ' ').trim()
  })
  const autoWaveWarehouseId =
    waveRows[0]?.warehouseId || taskPageRows[0]?.warehouseId || 'WH-E2E-001'
  const autoWavePreviewResponse = await api.postBusiness('/wms/operation/wave/auto/preview', {
    warehouseId: autoWaveWarehouseId,
    maxTasksPerWave: 50
  })
  const autoWavePreview = autoWavePreviewResponse?.data ?? autoWavePreviewResponse
  const autoWaveGroups = Array.isArray(autoWavePreview?.groups) ? autoWavePreview.groups : []
  caseRecord.checks.push({
    name: 'PB-298 自动组波预览按客户、预计发货日、到达地和优先级返回当前 PICK 任务分组',
    passed:
      autoWavePreview?.maxTasksPerWave === 50 &&
      autoWavePreview?.reservationMode === 'SOURCE_OUTBOUND_LOCK' &&
      autoWaveGroups.every(
        (group) =>
          typeof group?.groupKey === 'string' &&
          typeof group?.taskCount === 'number' &&
          Array.isArray(group?.tasks) &&
          group.tasks.every((task) => task?.taskType === 'PICK') &&
          group.tasks.every((task) => task?.sourceBillType === 'MesWmsSalesNotice')
      ),
    details: JSON.stringify({
      warehouseId: autoWaveWarehouseId,
      maxTasksPerWave: autoWavePreview?.maxTasksPerWave,
      reservationMode: autoWavePreview?.reservationMode,
      groupCount: autoWaveGroups.length
    })
  })

  // PB-297: putaway completion is the only execution path that moves pending stock to available stock.
  const putawayPage = await api.getBusiness(
    '/wms/operation/task/page?pageNo=1&pageSize=100&taskType=PUTAWAY'
  )
  const putawayData = putawayPage?.data ?? putawayPage
  const putawayRows = Array.isArray(putawayData?.list)
    ? putawayData.list
    : Array.isArray(putawayData?.records)
      ? putawayData.records
      : []
  caseRecord.checks.push({
    name: 'PUTAWAY 任务分页契约只返回上架任务且分页不超过 100',
    passed:
      typeof putawayData?.total === 'number' &&
      putawayRows.length <= 100 &&
      putawayRows.every((task) => task?.taskType === 'PUTAWAY'),
    details: JSON.stringify({ total: putawayData?.total, count: putawayRows.length })
  })

  // PB-298/PB-299: the pick task contract is queryable from the same WMS task domain.
  const pickPage = await api.getBusiness(
    '/wms/operation/task/page?pageNo=1&pageSize=100&taskType=PICK'
  )
  const pickData = pickPage?.data ?? pickPage
  const pickRows = Array.isArray(pickData?.list)
    ? pickData.list
    : Array.isArray(pickData?.records)
      ? pickData.records
      : []
  caseRecord.checks.push({
    name: 'PICK 任务分页契约只返回拣货任务且分页不超过 100',
    passed:
      typeof pickData?.total === 'number' &&
      pickRows.every((task) => task?.taskType === 'PICK') &&
      pickRows.length <= 100,
    details: JSON.stringify({ total: pickData?.total, count: pickRows.length })
  })
  if (pickRows.length > 0) {
    const pickDetailResponse = await api.getBusiness(`/wms/operation/task/get?id=${pickRows[0].id}`)
    const pickDetail = pickDetailResponse?.data ?? pickDetailResponse
    const pickLines = Array.isArray(pickDetail?.lines) ? pickDetail.lines : []
    caseRecord.checks.push({
      name: 'PICK 任务明细暴露移动端扫码所需的物料/批号/来源库位维度',
      passed:
        pickLines.length > 0 &&
        pickLines.every(
          (line) =>
            typeof line?.materialId === 'string' &&
            typeof line?.sourceLocationId === 'string' &&
            typeof line?.plannedQuantity === 'number'
        ),
      details: JSON.stringify({ taskId: pickRows[0].id, lineCount: pickLines.length })
    })
    caseRecord.checks.push({
      name: 'PICK 任务明细暴露短拣上报所需的计划/已拣数量契约',
      passed:
        pickLines.length > 0 &&
        pickLines.every(
          (line) =>
            typeof line?.plannedQuantity === 'number' &&
            (line?.actualQuantity === undefined ||
              line?.actualQuantity === null ||
              typeof line.actualQuantity === 'number')
        ),
      details: JSON.stringify({ taskId: pickRows[0].id, lineCount: pickLines.length })
    })
  }
  const pickShortageInvalid = await api.post('/wms/operation/task/pick/shortage', {})
  caseRecord.checks.push({
    name: 'PB-299 拣货确认只累计现场实际量，短拣仍通过既有 WMS 任务接口上报',
    passed:
      pickShortageInvalid?.code !== 0 &&
      typeof pickShortageInvalid?.msg === 'string' &&
      pickShortageInvalid.msg.length > 0,
    details: JSON.stringify(pickShortageInvalid)
  })
  const packPage = await api.getBusiness(
    '/wms/operation/task/page?pageNo=1&pageSize=100&taskType=PACK'
  )
  const packData = packPage?.data ?? packPage
  const packRows = Array.isArray(packData?.list)
    ? packData.list
    : Array.isArray(packData?.records)
      ? packData.records
      : []
  caseRecord.checks.push({
    name: 'PACK 任务分页契约只返回装箱核验任务且复用同一任务域',
    passed:
      typeof packData?.total === 'number' &&
      packRows.every((task) => task?.taskType === 'PACK') &&
      packRows.every((task) => task?.sourceBillType !== 'WmsPackingReview'),
    details: JSON.stringify({ total: packData?.total, count: packRows.length })
  })
  const checkTaskPage = await api.getBusiness(
    '/wms/operation/task/page?pageNo=1&pageSize=100&taskType=CHECK'
  )
  const checkTaskData = checkTaskPage?.data ?? checkTaskPage
  const checkTaskRows = Array.isArray(checkTaskData?.list)
    ? checkTaskData.list
    : Array.isArray(checkTaskData?.records)
      ? checkTaskData.records
      : []
  const invalidPackFinish = await api.post('/wms/operation/pack/finish', {})
  caseRecord.checks.push({
    name: 'PB-300 装箱核验不新增 CHECK 任务，封箱缺失箱码时执行参数校验',
    passed:
      checkTaskData?.total === 0 &&
      checkTaskRows.length === 0 &&
      invalidPackFinish?.code !== 0 &&
      typeof invalidPackFinish?.msg === 'string' &&
      invalidPackFinish.msg.length > 0,
    details: JSON.stringify({
      checkTaskTotal: checkTaskData?.total,
      invalidPackFinish
    })
  })
  const packagePage = await api.getBusiness(
    '/mes/wms/packing/page?pageNo=1&pageSize=100&withLines=true'
  )
  const packageData = packagePage?.data ?? packagePage
  const packageRows = Array.isArray(packageData?.list)
    ? packageData.list
    : Array.isArray(packageData?.records)
      ? packageData.records
      : []
  const packageStatuses = new Set([0, 10, 90])
  caseRecord.checks.push({
    name: '装箱分页契约返回合法状态且明细可供 PDA 核验',
    passed:
      packageRows.length <= 100 &&
      packageRows.every((pkg) => packageStatuses.has(pkg?.status)) &&
      packageRows.every((pkg) => (pkg?.lines || []).every((line) => line?.id && line?.itemId)),
    details: JSON.stringify({ total: packageData?.total, count: packageRows.length })
  })
  if (packageRows.length > 0) {
    const packageDetailResponse = await api.getBusiness(
      `/mes/wms/packing/get?id=${packageRows[0].id}`
    )
    const packageDetail = packageDetailResponse?.data ?? packageDetailResponse
    const packageLines = Array.isArray(packageDetail?.lines) ? packageDetail.lines : []
    caseRecord.checks.push({
      name: '装箱明细保留物料、批号、SN/条码和库位核验维度',
      passed:
        packageLines.every((line) => typeof line?.itemId === 'string') &&
        packageLines.every(
          (line) =>
            line?.batchNo !== undefined &&
            line?.snNo !== undefined &&
            line?.locationId !== undefined
        ),
      details: JSON.stringify({ packageId: packageRows[0].id, lineCount: packageLines.length })
    })
  }
  const shipPage = await api.getBusiness(
    '/wms/operation/task/page?pageNo=1&pageSize=100&taskType=SHIP'
  )
  const shipData = shipPage?.data ?? shipPage
  const shipRows = Array.isArray(shipData?.list)
    ? shipData.list
    : Array.isArray(shipData?.records)
      ? shipData.records
      : []
  caseRecord.checks.push({
    name: 'SHIP 任务分页契约只返回发运交接任务且复用 ASN out/装箱来源',
    passed:
      typeof shipData?.total === 'number' &&
      shipRows.length <= 100 &&
      shipRows.every((task) => task?.taskType === 'SHIP') &&
      shipRows.every((task) => task?.sourceBillType === 'MesWmsPackage'),
    details: JSON.stringify({ total: shipData?.total, count: shipRows.length })
  })
  const vehicleOptionsResponse = await api.getBusiness(
    '/wms/operation/transport-vehicle/options?pageNo=1&pageSize=100'
  )
  const vehicleOptions = Array.isArray(vehicleOptionsResponse?.list)
    ? vehicleOptionsResponse.list
    : []
  const invalidShipPrepare = await api.post('/wms/operation/ship/prepare', {
    packageCode: '__WMS_E2E_NOT_FOUND__'
  })
  const invalidShipReceipt = await api.post('/wms/operation/ship/receipt', {})
  caseRecord.checks.push({
    name: 'PB-301 发运交接只返回启用车辆选项，未知箱码进入业务校验而非创建第二套发运单',
    passed:
      vehicleOptions.length <= 100 &&
      vehicleOptions.every((vehicle) => vehicle?.status === 1) &&
      invalidShipPrepare?.code !== 0 &&
      typeof invalidShipPrepare?.msg === 'string' &&
      invalidShipPrepare.msg.length > 0 &&
      invalidShipReceipt?.code !== 0 &&
      typeof invalidShipReceipt?.msg === 'string' &&
      invalidShipReceipt.msg.length > 0,
    details: JSON.stringify({
      vehicleCount: vehicleOptions.length,
      invalidShipPrepare,
      invalidShipReceipt
    })
  })
  if (shipRows.length > 0) {
    const shipDetailResponse = await api.getBusiness(`/wms/operation/task/get?id=${shipRows[0].id}`)
    const shipDetail = shipDetailResponse?.data ?? shipDetailResponse
    const optionalString = (value) =>
      value === undefined || value === null || typeof value === 'string'
    caseRecord.checks.push({
      name: 'PB-301 SHIP 任务详情暴露物流锁定与签收回传状态，完成前由后端强制校验',
      passed:
        typeof shipDetail?.shipmentReceiptRecorded === 'boolean' &&
        (shipDetail?.shipmentReceiptSignedBy === undefined ||
          shipDetail?.shipmentReceiptSignedBy === null ||
          typeof shipDetail.shipmentReceiptSignedBy === 'string') &&
        optionalString(shipDetail?.shipmentLogisticsCompany) &&
        optionalString(shipDetail?.shipmentLogisticsNo) &&
        optionalString(shipDetail?.shipmentVehicleOrCarrier) &&
        optionalString(shipDetail?.shipmentHandoverPerson),
      details: JSON.stringify({
        taskId: shipRows[0].id,
        shipmentReceiptRecorded: shipDetail?.shipmentReceiptRecorded,
        shipmentLogisticsCompany: shipDetail?.shipmentLogisticsCompany,
        shipmentLogisticsNo: shipDetail?.shipmentLogisticsNo,
        shipmentVehicleOrCarrier: shipDetail?.shipmentVehicleOrCarrier,
        shipmentHandoverPerson: shipDetail?.shipmentHandoverPerson
      })
    })
  }
  const exceptionPageResponse = await api.getBusiness(
    '/wms/operation/exception/page?taskId=0&pageNo=1&pageSize=100'
  )
  const wmsExceptionRows = Array.isArray(exceptionPageResponse?.list)
    ? exceptionPageResponse.list
    : []
  caseRecord.checks.push({
    name: 'PB-302 异常分页保留附件地址契约，关闭处理仍由统一异常中心接口承载',
    passed:
      wmsExceptionRows.length <= 100 &&
      wmsExceptionRows.every(
        (item) =>
          item?.attachmentUrls === undefined ||
          item?.attachmentUrls === null ||
          typeof item.attachmentUrls === 'string'
      ),
    details: JSON.stringify({
      total: exceptionPageResponse?.total,
      count: wmsExceptionRows.length
    })
  })
  const logExceptionId = wmsExceptionRows[0]?.id || 0
  const exceptionLogsResponse = await api.getBusiness(
    `/wms/operation/exception/logs?exceptionId=${logExceptionId}`
  )
  const exceptionLogs = Array.isArray(exceptionLogsResponse?.data)
    ? exceptionLogsResponse.data
    : Array.isArray(exceptionLogsResponse)
      ? exceptionLogsResponse
      : []
  const exceptionActions = new Set(['CREATE', 'START', 'CLOSE'])
  const optionalLogString = (value) =>
    value === undefined || value === null || typeof value === 'string'
  caseRecord.checks.push({
    name: 'PB-302 异常处理日志返回 CREATE/START/CLOSE 流转、前后值和附件契约',
    passed: exceptionLogs.every(
      (log) =>
        log?.exceptionId === logExceptionId &&
        exceptionActions.has(log?.action) &&
        optionalLogString(log?.fromStatus) &&
        optionalLogString(log?.toStatus) &&
        optionalLogString(log?.fromValue) &&
        optionalLogString(log?.toValue) &&
        optionalLogString(log?.attachmentUrls)
    ),
    details: JSON.stringify({
      exceptionId: logExceptionId,
      count: exceptionLogs.length,
      actions: exceptionLogs.map((log) => log?.action)
    })
  })
  await saveScreenshot(page, outputDir, 'wms-operation-summary', record)
  caseRecord.evidence.push(
    '任务摘要 API、异常中心 API、PICK/PACK/SHIP 任务分页 API、现有 WMS 工作台摘要面板和浏览器截图'
  )
  return { token, api }
}
