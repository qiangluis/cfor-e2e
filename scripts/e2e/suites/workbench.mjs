import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

// 工作台/index 门户化改造（PB-342~PB-377）真实浏览器案例。
export const cases = [
  'WBF-001',
  'WBF-002',
  'WBF-003',
  'WBF-004',
  'WBF-005',
  'WBF-006',
  'WBF-007',
  'WBF-008',
  'WBF-009',
  'WBF-010',
  'WBF-011',
  'WBF-012'
]

const WORKBENCH_PATH = '/index'
const PROCESS_DETAIL_PATH = '/bpm/process-instance/detail'

// 门户区块编码 → 工作台面板选择器，用于校验按角色命中的门户区块组合（PB-373~377）。
const PORTAL_SECTION_SELECTORS = {
  'quick-actions': '.quick-actions-strip',
  todo: '.todo-panel',
  schedule: '.schedule-panel',
  message: '.message-panel',
  announcement: '.announcement-panel',
  focus: '.focus-panel',
  report: '.report-panel',
  culture: '.culture-panel',
  document: '.document-panel',
  contact: '.contact-panel',
  performance: '.performance-panel'
}

async function waitForTodoContent (todoPanel) {
  // Wait for the async todo request to render either real rows or the explicit empty state.
  const content = todoPanel.locator('.todo-body .work-list-row, .todo-body .el-empty').first()
  await content.waitFor({ state: 'visible', timeout: 60000 })
  return content
}

async function waitForProcessDetail (dialog) {
  const detail = dialog.locator('.processInstance-wrap-main').first()
  await detail.waitFor({ state: 'visible', timeout: 60000 })
  await detail.locator('.text-26px').first().waitFor({ state: 'visible', timeout: 60000 })
  return detail
}

async function openWorkbenchAndWaitForTodo (page) {
  // The initial Vue render briefly exposes an empty state before the async request starts.
  const todoResponse = page.waitForResponse(
    response =>
      response.url().includes('/workbench/todo/page') &&
      response.request().method() === 'GET' &&
      response.ok(),
    { timeout: 60000 }
  )
  await openRoute(page, WORKBENCH_PATH)
  await todoResponse
  const todoPanel = page.locator('.todo-panel').first()
  await todoPanel.waitFor({ state: 'visible' })
  await waitForTodoContent(todoPanel)
  return todoPanel
}

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })
  caseRecord.checks.push({
    name: '真实登录成功',
    passed: Boolean(token),
    details: '登录后携带真实令牌打开工作台并校验待办中心'
  })

  if (caseId === 'WBF-001') {
    const todoPanel = await openWorkbenchAndWaitForTodo(page)
    const todoHeading = (await todoPanel.locator('h2').first().innerText()).trim()
    caseRecord.checks.push({
      name: '工作台/index 渲染待办中心（统一工作入口）',
      passed: todoHeading.includes('待办'),
      details: `待办中心标题=${todoHeading}`
    })
    const tileCount = await todoPanel.locator('.todo-tile').count()
    caseRecord.checks.push({
      name: '待办中心提供来源/状态分面',
      passed: tileCount > 0,
      details: `待办分面数=${tileCount}`
    })
    await saveScreenshot(page, outputDir, 'wbf001-workbench-todo', record)
    caseRecord.evidence.push('WBF-001 校验工作台待办中心作为统一工作入口真实渲染')
    return { token, api }
  }

  if (caseId === 'WBF-002') {
    const todoPanel = await openWorkbenchAndWaitForTodo(page)
    const firstRow = todoPanel.locator('.todo-body .work-list-row').first()
    const hasTodo = (await firstRow.count()) > 0
    caseRecord.checks.push({
      name: '工作台待办清单存在可处理条目',
      passed: hasTodo,
      details: hasTodo ? '存在至少一条待办' : '当前账号无待办（该分面为空）'
    })
    if (!hasTodo) {
      caseRecord.notes.push('当前账号待办为空，弹窗交互无法取真实单据；保留清单渲染证据。')
      await saveScreenshot(page, outputDir, 'wbf002-workbench-todo-empty', record)
      throw new Error('BLOCKED: 需先通过真实 BPM 流程创建待办，不得跳过弹窗验证')
    }
    const pathBefore = new URL(page.url()).pathname
    await firstRow.click()
    const dialog = page.locator('.todo-detail-dialog').first()
    await dialog.waitFor({ state: 'visible' })
    const detail = await waitForProcessDetail(dialog)
    const dialogVisible = await dialog.isVisible()
    const detailRendered = await detail.count()
    const pathAfter = new URL(page.url()).pathname
    caseRecord.checks.push({
      name: '待办在门户内弹窗处理（PB-350/351）',
      passed: dialogVisible && detailRendered > 0,
      details: `弹窗可见=${dialogVisible}，流程详情渲染=${detailRendered > 0}`
    })
    caseRecord.checks.push({
      name: '处理待办不跳转到子系统页面（PB-350）',
      passed: pathAfter === pathBefore && !pathAfter.includes(PROCESS_DETAIL_PATH),
      details: `点击前=${pathBefore}，点击后=${pathAfter}`
    })
    await saveScreenshot(page, outputDir, 'wbf002-workbench-todo-dialog', record)
    caseRecord.evidence.push('WBF-002 校验待办在门户内弹窗打开原始单据，不离开工作台路由')
    return { token, api }
  }

  if (caseId === 'WBF-003') {
    const todoPanel = await openWorkbenchAndWaitForTodo(page)
    const firstRow = todoPanel.locator('.todo-body .work-list-row').first()
    const hasTodo = (await firstRow.count()) > 0
    if (!hasTodo) {
      throw new Error('BLOCKED: 需先通过真实 BPM 流程创建待办，不得把未执行的刷新链路记为通过')
    }
    await firstRow.click()
    const dialog = page.locator('.todo-detail-dialog').first()
    await dialog.waitFor({ state: 'visible' })
    await waitForProcessDetail(dialog)
    const refresh = page.waitForResponse(
      response => response.url().includes('/workbench/todo/page') && response.ok()
    )
    await dialog.locator('.el-dialog__headerbtn').first().click()
    await dialog.waitFor({ state: 'hidden' })
    await refresh
    const pathAfterClose = new URL(page.url()).pathname
    caseRecord.checks.push({
      name: '关闭处理弹窗后回到工作台并刷新待办（PB-352）',
      passed: pathAfterClose === WORKBENCH_PATH,
      details: `关闭后路由=${pathAfterClose}`
    })
    caseRecord.checks.push({
      name: '待办中心仍然可用',
      passed: await todoPanel.isVisible(),
      details: '关闭后待办中心仍在门户内渲染'
    })
    await saveScreenshot(page, outputDir, 'wbf003-workbench-todo-refresh', record)
    caseRecord.evidence.push('WBF-003 校验关闭处理弹窗后待办清单刷新且停留在工作台')
    return { token, api }
  }

  if (caseId === 'WBF-004') {
    await openRoute(page, WORKBENCH_PATH)
    const reportPanel = page.locator('.report-panel').first()
    await reportPanel.waitFor({ state: 'visible' })
    const reportTabs = reportPanel.locator('.panel-tabs button')
    const labels = await reportTabs.allTextContents()
    caseRecord.checks.push({
      name: '工作台聚合日报、周报、月报（PB-359~365）',
      passed: ['日报', '周报', '月报'].every((label) => labels.some((text) => text.includes(label))),
      details: `报告页签=${labels.map((item) => item.trim()).join(' / ')}`
    })
    caseRecord.checks.push({
      name: '工作报告区块保持在统一门户内',
      passed: new URL(page.url()).pathname === WORKBENCH_PATH,
      details: `当前路由=${new URL(page.url()).pathname}`
    })
    await saveScreenshot(page, outputDir, 'wbf004-work-report', record)
    caseRecord.evidence.push('WBF-004 校验 PMS 日报与 CRM 周报/月报在工作台聚合展示')
    return { token, api }
  }

  if (caseId === 'WBF-005') {
    await openRoute(page, WORKBENCH_PATH)
    const quickActions = page.locator('.quick-actions-strip').first()
    await quickActions.waitFor({ state: 'visible' })
    const purchaseOrderAction = quickActions.getByRole('button', { name: '新增采购订单' })
    const purchaseExecutionAction = quickActions.getByRole('button', { name: '采购执行表' })
    const hasPurchaseOrder = (await purchaseOrderAction.count()) > 0
    const hasPurchaseExecution = (await purchaseExecutionAction.count()) > 0
    caseRecord.checks.push({
      name: '采购快捷动作已提供（PB-367/368）',
      passed: hasPurchaseOrder && hasPurchaseExecution,
      details: `采购订单=${hasPurchaseOrder}，采购执行表=${hasPurchaseExecution}`
    })
    if (!hasPurchaseOrder || !hasPurchaseExecution) {
      caseRecord.notes.push('当前用户个人快捷配置未包含采购动作，需在“添加快捷”中启用后复测。')
      await saveScreenshot(page, outputDir, 'wbf005-procurement-actions-missing', record)
      return { token, api }
    }
    const pathBefore = new URL(page.url()).pathname
    await purchaseExecutionAction.click()
    const executionDialog = page.getByRole('dialog', { name: '采购执行表' }).first()
    await executionDialog.waitFor({ state: 'visible' })
    const pathAfter = new URL(page.url()).pathname
    caseRecord.checks.push({
      name: '采购执行表在门户弹窗打开（PB-368）',
      passed: pathAfter === pathBefore && (await executionDialog.isVisible()),
      details: `点击前=${pathBefore}，点击后=${pathAfter}`
    })
    await saveScreenshot(page, outputDir, 'wbf005-procurement-dialog', record)
    caseRecord.evidence.push('WBF-005 校验采购快捷动作以门户弹窗形式打开')
    return { token, api }
  }

  if (caseId === 'WBF-006') {
    await openRoute(page, WORKBENCH_PATH)
    const focusPanel = page.locator('.focus-panel').first()
    await focusPanel.waitFor({ state: 'visible' })
    const favoriteTab = focusPanel.getByRole('button', { name: /我的关注/ }).first()
    const visible = await favoriteTab.isVisible()
    if (visible) await favoriteTab.click()
    caseRecord.checks.push({
      name: '工作台提供用户级我的关注归集（PB-353~355）',
      passed: visible,
      details: `我的关注页签可见=${visible}`
    })
    caseRecord.checks.push({
      name: '我的关注保持用户当前门户上下文',
      passed: new URL(page.url()).pathname === WORKBENCH_PATH,
      details: `当前路由=${new URL(page.url()).pathname}`
    })
    await saveScreenshot(page, outputDir, 'wbf006-user-favorites', record)
    caseRecord.evidence.push('WBF-006 校验跨业务通用关注在工作台统一归集')
    return { token, api }
  }

  if (caseId === 'WBF-007') {
    // 取一条真实采购订单，验证“业务详情页关注 → 工作台我的关注归集”闭环（PB-354/355）
    const orderPage = await api.get('/erp/purchase-order/page?pageNo=1&pageSize=1')
    const order = orderPage?.data?.list?.[0]
    caseRecord.checks.push({
      name: '存在可用于关注验证的采购订单',
      passed: Boolean(order?.id),
      details: order ? `采购订单=${order.billNo || order.no || order.id}` : '当前租户无采购订单'
    })
    if (!order?.id) {
      throw new Error('BLOCKED: 需先通过采购页面/API 创建采购订单，不得跳过关注归集链路')
    }
    const bizType = 'erp_purchase_order'
    const bizId = String(order.id)
    const favoriteRoute = `/system/user-favorite/remove?bizType=${bizType}&bizId=${bizId}`
    // 先清理历史关注，保证按钮处于“未关注”初始态，且用例可重复执行
    await api.delete(favoriteRoute)

    await openRoute(page, `/purchase/order/formDetail/${bizId}`)
    const detailRoot = page.locator('.mainBox').first()
    const hasDetail = await detailRoot
      .waitFor({ state: 'visible', timeout: 60000 })
      .then(() => true)
      .catch(() => false)
    const actionGroup = detailRoot.locator('.btnGroup').first()
    const hasGroup = hasDetail && await actionGroup
      .waitFor({ state: 'visible', timeout: 60000 })
      .then(() => true)
      .catch(() => false)
    const favoriteButton = actionGroup.getByRole('button', { name: /关注/ }).first()
    const hasButton = hasGroup && await favoriteButton
      .waitFor({ state: 'visible', timeout: 60000 })
      .then(() => true)
      .catch(() => false)
    caseRecord.checks.push({
      name: '业务单据详情页提供通用关注按钮（PB-354）',
      passed: hasButton,
      details: hasButton
        ? '采购订单详情页存在关注按钮'
        : `详情主容器=${hasDetail}，操作区=${hasGroup}，当前URL=${page.url()}`
    })
    if (!hasButton) {
      caseRecord.notes.push('未在采购订单详情页找到关注按钮，可能为权限或详情页结构差异。')
      await saveScreenshot(page, outputDir, 'wbf007-favorite-button-missing', record)
      return { token, api }
    }
    await favoriteButton.click()
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
    const check = await api.get(
      `/system/user-favorite/check?bizType=${bizType}&bizId=${bizId}`
    )
    caseRecord.checks.push({
      name: '点击关注后关注关系落库（PB-354）',
      passed: check?.data === true,
      details: `关注校验接口返回=${JSON.stringify(check?.data)}`
    })

    // The workbench renders an empty state before the async favorite page finishes.
    // Register the response listener before navigation so the assertion follows the
    // actual data request instead of racing the initial Vue render.
    const favoritePageResponse = page.waitForResponse(
      response =>
        response.url().includes('/system/user-favorite/page') &&
        response.request().method() === 'GET' &&
        response.ok(),
      { timeout: 60000 }
    )
    await openRoute(page, WORKBENCH_PATH)
    await favoritePageResponse
    const panel = page.locator('.focus-panel').first()
    await panel.waitFor({ state: 'visible' })
    const favoriteTab = panel.getByRole('button', { name: /我的关注/ }).first()
    if (await favoriteTab.isVisible()) await favoriteTab.click()
    const expectedTitle = `采购订单 ${order.billNo || order.no || ''}`.trim()
    const favoriteRow = panel
      .locator('.focus-body .focus-row')
      .filter({ hasText: expectedTitle })
      .first()
    const collected = await favoriteRow
      .waitFor({ state: 'visible', timeout: 60000 })
      .then(() => 1)
      .catch(() => 0)
    caseRecord.checks.push({
      name: '关注单据自动归集到工作台我的关注（PB-355）',
      passed: collected > 0,
      details: `匹配“${expectedTitle}”的条目数=${collected}`
    })
    await saveScreenshot(page, outputDir, 'wbf007-detail-favorite-to-workbench', record)
    caseRecord.evidence.push('WBF-007 校验详情页关注采购订单后在工作台我的关注中自动归集')
    // 清理本用例产生的关注关系，避免污染后续用例
    await api.delete(favoriteRoute)
    return { token, api }
  }

  if (caseId === 'WBF-008') {
    // 报表统计/提醒汇总与个人周报格式（PB-363~365）
    const preferenceKey = 'workbench.report.weekly-metrics'
    const previousPreference = await api.get(
      `/system/user-preference/get?key=${encodeURIComponent(preferenceKey)}`
    )
    await openRoute(page, WORKBENCH_PATH)
    const reportPanel = page.locator('.report-panel').first()
    await reportPanel.waitFor({ state: 'visible' })
    const reminderText = await reportPanel.locator('.focus-body').innerText()
    const reminderKinds = ['日报', '周报', '月报'].filter((kind) => reminderText.includes(kind))
    caseRecord.checks.push({
      name: '工作报告区块展示日报/周报/月报提醒汇总（PB-365）',
      passed: reminderKinds.length === 3,
      details: `命中提醒类型=${reminderKinds.join('/')}`
    })
    caseRecord.checks.push({
      name: '提醒包含已填/未填与待审批统计口径（PB-364）',
      passed: reminderText.includes('待审批') && /已填写|未填写/.test(reminderText),
      details: `提醒文案=${reminderText.replace(/\s+/g, ' ').slice(0, 160)}`
    })

    const formatButton = reportPanel.getByRole('button', { name: '格式' }).first()
    caseRecord.checks.push({
      name: '工作报告提供个人周报格式入口（PB-363）',
      passed: await formatButton.isVisible(),
      details: '报告区块存在“格式”入口'
    })
    if (await formatButton.isVisible()) {
      await formatButton.click()
      const dialog = page.getByRole('dialog', { name: '个人周报格式' }).first()
      await dialog.waitFor({ state: 'visible' })
      const checkboxes = dialog.locator('.el-checkbox')
      const checkboxCount = await checkboxes.count()
      await checkboxes.first().click()
      await dialog.getByRole('button', { name: '保存' }).first().click()
      await dialog.waitFor({ state: 'hidden' })
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
      const savedPreference = await api.get(
        `/system/user-preference/get?key=${encodeURIComponent(preferenceKey)}`
      )
      caseRecord.checks.push({
        name: '周报格式按用户维度持久化（PB-363）',
        passed: typeof savedPreference?.data === 'string' && savedPreference.data.length > 0,
        details: `可选字段数=${checkboxCount}，保存值=${JSON.stringify(savedPreference?.data)}`
      })
    }
    await saveScreenshot(page, outputDir, 'wbf008-report-reminders-format', record)
    caseRecord.evidence.push('WBF-008 校验报表提醒汇总与个人周报格式保存')
    // 还原用例开始前的个人格式偏好
    if (typeof previousPreference?.data === 'string' && previousPreference.data.length > 0) {
      await api.put(
        `/system/user-preference/save?key=${encodeURIComponent(preferenceKey)}`,
        { value: previousPreference.data }
      )
    }
    return { token, api }
  }

  if (caseId === 'WBF-009') {
    // 多门户与角色绑定：校验登录权限信息下发的门户区块与工作台实际渲染一致（PB-373~377）
    const permission = await api.get('/system/auth/get-permission-info')
    const portal = permission?.data
    const configured = Array.isArray(portal?.portalSections)
    const portalSections = configured ? portal.portalSections : []
    caseRecord.checks.push({
      name: '登录权限信息下发门户标识与区块组合（PB-377）',
      passed: permission?.code === 0 && (configured || portal?.portalSections == null),
      details: `门户编码=${portal?.portalCode || '（未配置，展示全部区块）'}，区块数=${portalSections.length}`
    })

    await openRoute(page, WORKBENCH_PATH)
    await page.locator('.personal-workbench').first().waitFor({ state: 'visible' })

    const visibility = {}
    for (const [key, selector] of Object.entries(PORTAL_SECTION_SELECTORS)) {
      visibility[key] = (await page.locator(selector).count()) > 0
    }
    const visibleKeys = Object.keys(visibility).filter((key) => visibility[key])

    if (portalSections.length === 0) {
      // 未配置门户时展示全部区块：允许按权限或数据为空省略个别面板，但主区块应存在。
      caseRecord.checks.push({
        name: '未命中门户时工作台展示默认区块组合',
        passed: visibleKeys.length > 0,
        details: `可见区块=${visibleKeys.join('/') || '（无）'}`
      })
    } else {
      const missing = portalSections.filter((key) => visibility[key] !== true)
      const unexpected = visibleKeys.filter((key) => !portalSections.includes(key))
      caseRecord.checks.push({
        name: '门户区块按角色配置显隐（PB-374~376）',
        passed: missing.length === 0 && unexpected.length === 0,
        details: `配置区块=${portalSections.join('/')}；缺失=${missing.join('/') || '无'}；越权区块=${unexpected.join('/') || '无'}`
      })
    }

    await saveScreenshot(page, outputDir, 'wbf009-portal-sections', record)
    caseRecord.evidence.push('WBF-009 校验按角色命中的门户区块组合在工作台真实显隐')
    return {
      token, api, notImplemented: !configured,
      note: '仅验证未配置门户的默认区块；需补真实角色与门户映射及无权限账号反例'
    }
  }

  if (caseId === 'WBF-010') {
    // OA 统一资源预约中心（会议室）与工作台我的日程只读聚合（PB-371）
    const suffix = String(Date.now()).slice(-6)
    const roomName = `自动化会议室-${suffix}`
    const subject = `自动化会议-${suffix}`
    const conflictSubject = `${subject}-冲突`
    const day = new Date()
    day.setHours(day.getHours() + 1, 0, 0, 0)
    const end = new Date(day.getTime() + 60 * 60 * 1000)
    const formatDateTime = (value) => {
      const pad = (part) => String(part).padStart(2, '0')
      return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(
        value.getHours()
      )}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
    }
    const startTime = formatDateTime(day)
    const endTime = formatDateTime(end)
    let roomId
    let bookingId

    try {
      await openRoute(page, '/settings/hrm/meeting-room')
      await page.getByRole('button', { name: '新增会议室' }).first().click()
      const roomDialog = page.getByRole('dialog').last()
      await roomDialog.waitFor({ state: 'visible' })
      const roomFormItem = (label) =>
        roomDialog.locator('.el-form-item').filter({ hasText: label }).first()
      await roomFormItem('会议室名称').locator('input').first().fill(roomName)
      await roomFormItem('所在位置').locator('input').first().fill('自动化测试区')
      await roomFormItem('容纳人数').locator('input').first().fill('8')
      await roomFormItem('设备设施').locator('input').first().fill('投影仪,白板')
      await roomDialog.getByRole('button', { name: '保存' }).click()
      await roomDialog.waitFor({ state: 'hidden' })
      const roomPage = await api.get(
        `/oa/meeting-room/page?pageNo=1&pageSize=10&name=${encodeURIComponent(roomName)}`
      )
      roomId = roomPage?.data?.list?.[0]?.id
      caseRecord.checks.push({
        name: '会议室设置页可创建 OA 会议室台账（PB-371）',
        passed: Boolean(roomId),
        details: `会议室编号=${roomId || '未落库'}`
      })
      if (!roomId) {
        caseRecord.notes.push('会议室创建未落库，终止预约冲突与工作台聚合验证。')
        await saveScreenshot(page, outputDir, 'wbf010-room-create-failed', record)
        return { token, api }
      }

      await openRoute(page, '/oa/reservation/meeting-room')
      await page.getByRole('button', { name: '新增预约' }).first().click()
      // Date pickers also render role="dialog"; keep the booking form anchored to
      // its title so opening the start-time picker does not retarget the locator.
      const bookingDialog = page.locator('.el-dialog').filter({ hasText: '新增会议预约' }).last()
      await bookingDialog.waitFor({ state: 'visible' })
      const bookingFormItem = (label) =>
        bookingDialog.locator('.el-form-item').filter({ hasText: label }).first()
      await bookingFormItem('会议主题').locator('input').first().fill(subject)
      await bookingFormItem('会议室').locator('.el-select').first().click()
      await page.getByRole('option', { name: new RegExp(roomName) }).first().click()
      const startTimeInput = bookingFormItem('开始时间').locator('input').first()
      await startTimeInput.fill(startTime)
      await startTimeInput.press('Tab')
      const endTimeInput = bookingFormItem('结束时间').locator('input').first()
      await endTimeInput.fill(endTime)
      await endTimeInput.press('Tab')
      await bookingDialog.getByRole('button', { name: '保存' }).click()
      await bookingDialog.waitFor({ state: 'hidden' })
      const bookingPage = await api.get(
        `/oa/meeting-booking/page?pageNo=1&pageSize=10&subject=${encodeURIComponent(subject)}`
      )
      bookingId = bookingPage?.data?.list?.[0]?.id
      caseRecord.checks.push({
        name: '会议室预约页可通过真实表单创建会议预约（PB-371）',
        passed: Boolean(bookingId),
        details: `预约编号=${bookingId || '未落库'}；时间=${startTime} ~ ${endTime}`
      })

      const conflict = await api.post('/oa/meeting-booking/create', {
        roomId,
        subject: conflictSubject,
        attendeeUserIds: [],
        startTime,
        endTime,
        description: '自动化冲突校验'
      })
      caseRecord.checks.push({
        name: '同一会议室同时间区间的重复预约被后端拒绝（PB-371）',
        passed: conflict?.code !== 0 && String(conflict?.msg || '').includes('已被占用'),
        details: `冲突返回 code=${conflict?.code}，msg=${conflict?.msg || ''}`
      })

      const meetingResponse = page.waitForResponse(
        response =>
          response.url().includes('/oa/meeting-booking/my-range') &&
          response.request().method() === 'GET' &&
          response.ok(),
        { timeout: 60000 }
      )
      await openRoute(page, WORKBENCH_PATH)
      await meetingResponse
      const schedulePanel = page.locator('.schedule-panel').first()
      await schedulePanel.waitFor({ state: 'visible' })
      await schedulePanel
        .locator('.agenda-row, .el-empty')
        .first()
        .waitFor({ state: 'visible', timeout: 60000 })
      const weekStart = (value) => {
        const result = new Date(value)
        result.setHours(0, 0, 0, 0)
        const offset = (result.getDay() + 6) % 7
        result.setDate(result.getDate() - offset)
        return result
      }
      const weekOffset = Math.round(
        (weekStart(day).getTime() - weekStart(new Date()).getTime()) / (7 * 24 * 60 * 60 * 1000)
      )
      const weekButton = weekOffset >= 0
        ? page.getByRole('button', { name: '下一周' })
        : page.getByRole('button', { name: '上一周' })
      for (let index = 0; index < Math.abs(weekOffset); index++) {
        await weekButton.click()
      }
      const targetWeekday = (day.getDay() + 6) % 7
      await page.locator('.week-days button').nth(targetWeekday).click()
      const meetingText = await schedulePanel.innerText()
      caseRecord.checks.push({
        name: '工作台我的日程只读聚合 OA 会议室预约（PB-371）',
        passed: meetingText.includes(subject),
        details: meetingText.includes(subject)
          ? `日程区出现会议主题=${subject}`
          : `日程区未出现会议主题=${subject}`
      })
      await saveScreenshot(page, outputDir, 'wbf010-meeting-reservation-workbench', record)
      caseRecord.evidence.push('WBF-010 校验会议室台账、时段冲突与工作台 OA 会议只读聚合')
      return { token, api }
    } finally {
      if (bookingId) {
        await api
          .put(`/oa/meeting-booking/cancel?id=${bookingId}`)
          .catch(() => undefined)
      } else {
        const bookingPage = await api
          .get(`/oa/meeting-booking/page?pageNo=1&pageSize=10&subject=${encodeURIComponent(subject)}`)
          .catch(() => undefined)
        const cleanupId = bookingPage?.data?.list?.[0]?.id
        if (cleanupId) {
          await api.put(`/oa/meeting-booking/cancel?id=${cleanupId}`).catch(() => undefined)
        }
      }
      if (roomId) {
        await api.delete(`/oa/meeting-room/delete?id=${roomId}`).catch(() => undefined)
      }
    }
  }

  if (caseId === 'WBF-011') {
    // 发送调查与待填写回收（PB-358）：事实源在 HRM，工作台只做发送入口与填写回收。
    const suffix = String(Date.now()).slice(-6)
    const title = `自动化调查-${suffix}`
    const permission = await api.get('/system/auth/get-permission-info')
    const currentUserId = permission?.data?.user?.id
    if (!currentUserId) throw new Error('当前登录人编号回读失败，禁止向空范围发放调查')
    caseRecord.checks.push({
      name: '获取当前登录人编号用于定向发放调查',
      passed: Boolean(currentUserId),
      details: `当前用户编号=${currentUserId || '未获取'}`
    })

    const created = await api.post('/hrm/survey/send', {
      title,
      description: '自动化测试调查，请选择后提交',
      anonymous: false,
      recipientUserIds: currentUserId ? [currentUserId] : [],
      questions: [
        {
          title: '满意度',
          questionType: 1,
          required: true,
          options: ['满意', '一般'],
          sort: 0
        }
      ]
    })
    const surveyId = created?.data
    caseRecord.checks.push({
      name: '工作台发送调查调用 HRM 通用问卷接口（PB-358）',
      passed: created?.code === 0 && Boolean(surveyId),
      details: `问卷编号=${surveyId || '未落库'}，返回 code=${created?.code}`
    })
    if (!surveyId) {
      caseRecord.notes.push('问卷未落库，终止工作台待填写回收验证。')
      return { token, api }
    }

    await openRoute(page, WORKBENCH_PATH)
    const announcementPanel = page.locator('.announcement-panel').first()
    await announcementPanel.waitFor({ state: 'visible' })
    const surveyRow = announcementPanel.locator('.survey-row').filter({ hasText: title }).first()
    await surveyRow.waitFor({ state: 'visible', timeout: 15000 })
    caseRecord.checks.push({
      name: '待填写调查显示在工作台通知公告区块（PB-358）',
      passed: (await surveyRow.count()) > 0,
      details: `调查标题=${title}`
    })

    await surveyRow.click()
    const submitDialog = page.locator('.survey-submit-dialog').first()
    await submitDialog.waitFor({ state: 'visible' })
    await submitDialog
      .locator('label.el-radio')
      .filter({ hasText: '满意' })
      .first()
      .click()
    await submitDialog.getByRole('button', { name: '提交' }).click()
    await submitDialog.waitFor({ state: 'hidden' })

    const pendingAfterSubmit = await api.get('/hrm/survey/my-pending')
    const stillPending = (pendingAfterSubmit?.data || []).some((item) => item.surveyId === surveyId)
    caseRecord.checks.push({
      name: '提交后问卷从待填写清单回收（PB-358）',
      passed: !stillPending,
      details: stillPending ? '提交后仍出现在待填写清单' : '提交后已从待填写清单移除'
    })

    await announcementPanel
      .locator('.survey-row')
      .filter({ hasText: title })
      .first()
      .waitFor({ state: 'hidden', timeout: 15000 })
      .catch(() => undefined)
    caseRecord.checks.push({
      name: '提交后工作台不再展示该待填写调查',
      passed:
        (await announcementPanel.locator('.survey-row').filter({ hasText: title }).count()) === 0,
      details: `调查标题=${title}`
    })
    await saveScreenshot(page, outputDir, 'wbf011-survey-collected', record)
    caseRecord.evidence.push('WBF-011 校验发送调查、工作台待填写展示与提交回收链路')
    caseRecord.notes.push('HRM 问卷当前无删除接口，用例保留一条已提交问卷记录，待补作废/删除能力后再实现硬清理。')
    return { token, api }
  }

  if (caseId === 'WBF-012') {
    // 报表统计（PB-364）：按周期与数据权限范围汇总日报/周报/月报口径。
    await openRoute(page, WORKBENCH_PATH)
    const reportPanel = page.locator('.report-panel').first()
    await reportPanel.waitFor({ state: 'visible' })
    await reportPanel.getByRole('button', { name: '统计' }).first().click()
    const statsDialog = page.locator('.report-stats-dialog').first()
    await statsDialog.waitFor({ state: 'visible' })

    const rowLabels = await statsDialog.locator('.el-table__body tr td:first-child').allInnerTexts()
    const normalizedRows = rowLabels.map((text) => text.trim()).filter(Boolean)
    caseRecord.checks.push({
      name: '报表统计覆盖日报/周报/月报口径（PB-364）',
      passed: ['日报', '周报', '月报'].every((label) => normalizedRows.includes(label)),
      details: `统计行=${normalizedRows.join('/') || '（无）'}`
    })

    await statsDialog
      .locator('label.el-radio-button')
      .filter({ hasText: '本季度' })
      .first()
      .click()
    await page.waitForTimeout(300)
    caseRecord.checks.push({
      name: '报表统计支持周期切换（PB-364）',
      passed: (await statsDialog
        .locator('label.el-radio-button')
        .filter({ hasText: '本季度' })
        .first()
        .getAttribute('class') || '').includes('is-active'),
      details: '切换到本季度统计周期'
    })

    await statsDialog
      .locator('label.el-radio-button')
      .filter({ hasText: '团队（按数据权限）' })
      .first()
      .click()
    await page.waitForTimeout(300)
    caseRecord.checks.push({
      name: '报表统计支持按数据权限范围查看（PB-364）',
      passed: (await statsDialog
        .locator('label.el-radio-button')
        .filter({ hasText: '团队（按数据权限）' })
        .first()
        .getAttribute('class') || '').includes('is-active'),
      details: '团队范围由后端数据权限限定，工作台不放大可见范围'
    })

    await statsDialog.getByRole('button', { name: '关闭', exact: true }).click()
    await statsDialog.waitFor({ state: 'hidden' })
    caseRecord.checks.push({
      name: '关闭统计后仍停留在工作台',
      passed: new URL(page.url()).pathname === WORKBENCH_PATH,
      details: `当前路由=${new URL(page.url()).pathname}`
    })
    await saveScreenshot(page, outputDir, 'wbf012-report-stats', record)
    caseRecord.evidence.push('WBF-012 校验报表统计周期切换与数据权限范围口径')
    return { token, api }
  }
}
